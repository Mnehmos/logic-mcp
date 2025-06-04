#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from 'crypto';
import sqlite3 from 'sqlite3';
import path from 'path';
import crypto from 'crypto'; // For hashing
import dotenv from 'dotenv';
import axios from 'axios';
import express, { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';

// Load environment variables from .env file
dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const HTTP_PORT = process.env.WEBAPP_PORT || 3001;

// Default LLM Configuration Constants
const DEFAULT_LLM_PROVIDER = "openrouter";
const DEFAULT_LLM_MODEL = "deepseek/deepseek-r1-0528:free";
// The key for this default will be derived (e.g., OPENROUTER_API_KEY)

const DB_FILE_NAME = 'logic_mcp.db';
const DB_PATH = path.join(process.cwd(), DB_FILE_NAME); // Assumes server runs from its root dir

let db: sqlite3.Database;

const app = express();

// Add error event listeners to catch any unhandled errors
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION:', error);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// New Global Logging Middleware - Add this EARLY
app.use((req, res, next) => {
  console.log(`GLOBAL LOGGER: Received ${req.method} request for ${req.originalUrl}`);
  console.log('GLOBAL LOGGER: Headers:', JSON.stringify(req.headers));
  // Don't try to read body here as it conflicts with express.json()
  next();
});

// Middleware with error handling
app.use(cors()); // Enable CORS for all routes

// Wrap express.json() to catch parsing errors
app.use((req, res, next) => {
  express.json()(req, res, (err) => {
    if (err) {
      console.error('JSON PARSING ERROR:', err);
      console.error('Failed on request:', req.method, req.originalUrl);
      res.status(400).json({ error: 'Invalid JSON', details: err.message });
      return;
    }
    next();
  });
});

async function initializeDatabase() {
  return new Promise<void>((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Error opening database', err.message);
        return reject(err);
      }
      console.log('Connected to the SQLite database.');

      // Read and execute schema
      // Schema from projects/MCP_Server_Upgrade/design/trace_schema.sql
      const schema = `
-- SQLite schema for MCP server operation tracing
-- Supports full history reconstruction and logic chain visualization

-- Core operations table
CREATE TABLE IF NOT EXISTS operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,  -- Unique identifier for the operation
    operation_name TEXT,                -- Human-readable name for the operation
    primitive_name TEXT NOT NULL,       -- Name of the logic primitive
    input_data TEXT,                    -- JSON-encoded input parameters
    output_data TEXT,                   -- JSON-encoded output results
    status TEXT NOT NULL,               -- success, failure, in_progress
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,
    context TEXT                        -- Additional execution context (JSON)
);

-- Operation relationships for sequencing and branching
CREATE TABLE IF NOT EXISTS operation_relationships (
    parent_id INTEGER NOT NULL,         -- Parent operation ID
    child_id INTEGER NOT NULL,          -- Child operation ID
    relationship_type TEXT NOT NULL,    -- sequential, branch, parallel
    sequence_order INTEGER,             -- Order in sequence
    
    PRIMARY KEY (parent_id, child_id),
    FOREIGN KEY (parent_id) REFERENCES operations(id),
    FOREIGN KEY (child_id) REFERENCES operations(id)
);

-- Logic chain metadata
CREATE TABLE IF NOT EXISTS logic_chains (
    chain_id TEXT PRIMARY KEY,          -- Unique chain identifier
    chain_name TEXT,                    -- Human-readable name for the chain
    description TEXT,                   -- Human-readable description
    root_operation INTEGER,             -- Starting operation ID
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (root_operation) REFERENCES operations(id)
);

-- Check and add chain_name column if it doesn't exist
PRAGMA table_info(logic_chains);
-- This PRAGMA statement is executed as part of the schema string,
-- but its results are not directly accessible here.
-- The logic to check and alter will be added in the TypeScript code.

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_operations_primitive ON operations(primitive_name);
CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_relationships_parent ON operation_relationships(parent_id);
CREATE INDEX IF NOT EXISTS idx_relationships_child ON operation_relationships(child_id);

-- LLM Configurations Table
CREATE TABLE IF NOT EXISTS llm_configurations (
  id TEXT PRIMARY KEY, -- UUID for unique identification of each configuration
  provider TEXT NOT NULL, -- e.g., "OpenRouter", "OpenAI", "Anthropic"
  model TEXT NOT NULL, -- e.g., "deepseek/deepseek-r1-0528:free", "gpt-4o-mini", "claude-3-opus-20240229"
  is_active BOOLEAN NOT NULL DEFAULT FALSE, -- Only one configuration can be active at a time
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Ensure only one configuration can be active at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_llm_config ON llm_configurations (is_active) WHERE is_active = TRUE;
    `;

      db.exec(schema, (execErr) => {
        if (execErr) {
          console.error('Error executing schema', execErr.message);
          return reject(execErr);
        }
        console.log('Database schema applied successfully.');

        try {
          // Check and add chain_name column if it doesn't exist
          db.all(`PRAGMA table_info(logic_chains);`, (err, columns: any[]) => {
            if (err) {
              console.error('Error checking logic_chains schema:', err.message);
              return reject(err);
            }
            const hasChainName = columns.some(col => col.name === 'chain_name');
            if (!hasChainName) {
              db.exec(`ALTER TABLE logic_chains ADD COLUMN chain_name TEXT;`, (alterErr) => {
                if (alterErr) {
                  console.error('Error adding chain_name column to logic_chains:', alterErr.message);
                  return reject(alterErr);
                }
                console.log("Added chain_name column to logic_chains table.");
                // Proceed to check operations table after this alter is done
                checkAndAddOperationNameColumn();
              });
            } else {
              // If chain_name already exists, proceed to check operations table
              checkAndAddOperationNameColumn();
            }
          });

          function checkAndAddOperationNameColumn() {
            // Check and add operation_name column to operations table
            db.all(`PRAGMA table_info(operations);`, (err, columns: any[]) => {
              if (err) {
                console.error('Error checking operations schema:', err.message);
                return reject(err);
              }
              const hasOperationName = columns.some(col => col.name === 'operation_name');
              if (!hasOperationName) {
                db.exec(`ALTER TABLE operations ADD COLUMN operation_name TEXT;`, (alterErr) => {
                  if (alterErr) {
                    console.error('Error adding operation_name column to operations:', alterErr.message);
                    return reject(alterErr);
                  }
                  console.log("Added operation_name column to operations table.");
                  resolve(); // All checks and alters are done
                });
              } else {
                resolve(); // All checks and alters are done
              }
            });
          }
        } catch (syncError: any) {
          console.error('Synchronous error during database schema checks:', syncError.message);
          reject(syncError);
        }
      });
    });
  });
}


// --- Zod Schemas for Operation Parameters ---

const observeParamsSchema = z.object({
  source_description: z.string().describe("Description of the data source (e.g., 'user input', 'file:./data.txt', 'url:http://example.com/api')"),
  data_format: z.string().optional().describe("Expected format of the data (e.g., 'text', 'json', 'markdown')"),
  raw_data: z.any().optional().describe("Actual raw data if provided directly, otherwise source_description will be used to fetch/identify it."),
}).describe("Parameters for an 'observe' operation: Ingests raw data.");

const defineParamsSchema = z.object({
  concept_name: z.string().describe("Name of the concept to define."),
  based_on_observation_ids: z.array(z.string().uuid()).optional().describe("IDs of observations to base the definition on."),
  description: z.string().optional().describe("A textual description or criteria for the definition."),
}).describe("Parameters for a 'define' operation: Creates a conceptual definition.");

const inferParamsSchema = z.object({
  premise_operation_ids: z.array(z.string().uuid()).describe("IDs of previous operations (observations, definitions, other inferences) to use as premises."),
  inference_type: z.enum(["deductive", "inductive", "abductive", "analogical"]).optional().default("deductive").describe("Type of inference to perform."),
  prompt_or_query: z.string().optional().describe("A specific prompt, question, or hypothesis to guide the inference process."),
}).describe("Parameters for an 'infer' operation: Draws conclusions from premises.");

const decideParamsSchema = z.object({
  decision_prompt: z.string().describe("The question, problem, or context requiring a decision."),
  option_operation_ids: z.array(z.string().uuid()).describe("IDs of previous operations representing the options to choose from."),
  criteria_operation_id: z.string().uuid().optional().describe("ID of a 'define' operation that specifies the decision criteria."),
  decision_method: z.string().optional().describe("Method or strategy for making the decision (e.g., 'utility-based', 'rule-based')."),
}).describe("Parameters for a 'decide' operation: Makes a choice between options based on criteria.");

const synthesizeParamsSchema = z.object({
  input_operation_ids: z.array(z.string().uuid()).describe("IDs of various operations (observations, definitions, inferences) to combine."),
  synthesis_goal: z.string().describe("The objective of the synthesis (e.g., 'summary', 'plan', 'explanation')."),
  output_format: z.string().optional().describe("Desired format for the synthesized output (e.g., 'markdown', 'json_report')."),
}).describe("Parameters for a 'synthesize' operation: Combines information into a coherent whole.");

const distinguishParamsSchema = z.object({
  item_a_id: z.string().uuid().describe("ID of the first item/operation output to distinguish."),
  item_b_id: z.string().uuid().describe("ID of the second item/operation output to distinguish."),
  criteria: z.string().optional().describe("Criteria for distinguishing or classifying."),
  categories: z.array(z.string()).optional().describe("Predefined categories for classification."),
}).describe("Parameters for a 'distinguish' operation: Compares/classifies items.");

const decideOrderParamsSchema = z.object({
  item_ids: z.array(z.string().uuid()).describe("Array of item/operation output IDs to order."),
  criteria: z.string().describe("Criteria for ordering."),
}).describe("Parameters for a 'decide_order' operation: Determines logical sequences.");

const sequenceParamsSchema = z.object({
  ordered_item_ids: z.array(z.string().uuid()).describe("Array of item/operation output IDs in their determined order."),
  sequence_name: z.string().optional().describe("Optional name for the sequence."),
}).describe("Parameters for a 'sequence' operation: Stores ordered items.");

const compareParamsSchema = z.object({
  item_ids: z.array(z.string().uuid()).describe("Array of item/operation output IDs to compare."),
  criteria: z.string().describe("Criteria for comparison."),
  goal: z.string().optional().describe("Goal of the comparison."),
}).describe("Parameters for a 'compare' operation: Evaluates items against criteria.");

const reflectParamsSchema = z.object({
  target_operation_ids: z.array(z.string().uuid()).describe("IDs of operations to reflect upon."),
  reflection_prompt: z.string().describe("Prompt guiding the reflection process."),
}).describe("Parameters for a 'reflect' operation: Performs meta-cognition.");

const askParamsSchema = z.object({
  information_need: z.string().describe("Description of the information needed."),
  target_source: z.string().optional().describe("Suggested source or type of source for the information."),
  query_params: z.record(z.any()).optional().describe("Additional parameters for formulating the query."),
}).describe("Parameters for an 'ask' operation: Formulates information requests, potentially for external tools.");

const adaptParamsSchema = z.object({
  target_operation_id: z.string().uuid().describe("ID of the operation output to adapt."),
  adaptation_instruction: z.string().describe("Instructions on how to adapt the target."),
  feedback_id: z.string().uuid().optional().describe("ID of a feedback operation, if adaptation is based on specific feedback."),
}).describe("Parameters for an 'adapt' operation: Modifies artifacts based on feedback or instructions.");

const retrieveArtifactParamsSchema = z.object({
  artifact_id: z.string().uuid().describe("ID of the artifact/operation output to retrieve."),
  version: z.string().optional().describe("Optional version of the artifact to retrieve."),
}).describe("Parameters for a 'retrieve_artifact' operation: Retrieves stored artifacts/operation outputs.");

const retrieveObservationParamsSchema = z.object({
  observation_id: z.string().uuid().describe("ID of the specific observation to retrieve."),
  filter_criteria: z.record(z.any()).optional().describe("Optional criteria to filter or select parts of the observation."),
}).describe("Parameters for a 'retrieve_observation' operation: Retrieves specific observations.");


// --- Discriminated Union for Operations ---
const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("observe"), params: observeParamsSchema }),
  z.object({ type: z.literal("define"), params: defineParamsSchema }),
  z.object({ type: z.literal("infer"), params: inferParamsSchema }),
  z.object({ type: z.literal("decide"), params: decideParamsSchema }),
  z.object({ type: z.literal("synthesize"), params: synthesizeParamsSchema }),
  z.object({ type: z.literal("distinguish"), params: distinguishParamsSchema }),
  z.object({ type: z.literal("decide_order"), params: decideOrderParamsSchema }),
  z.object({ type: z.literal("sequence"), params: sequenceParamsSchema }),
  z.object({ type: z.literal("compare"), params: compareParamsSchema }),
  z.object({ type: z.literal("reflect"), params: reflectParamsSchema }),
  z.object({ type: z.literal("ask"), params: askParamsSchema }),
  z.object({ type: z.literal("adapt"), params: adaptParamsSchema }),
  z.object({ type: z.literal("retrieve_artifact"), params: retrieveArtifactParamsSchema }),
  z.object({ type: z.literal("retrieve_observation"), params: retrieveObservationParamsSchema }),
]).describe("Defines the type of logic operation to perform and its specific parameters.");
// --- API Routes for LLM Configuration ---
const llmConfigRouter: Router = express.Router();
// New logging middleware for this router
llmConfigRouter.use((req, res, next) => {
  console.log(`llmConfigRouter: Request received for ${req.method} ${req.originalUrl} (path on router: ${req.path})`);
  next();
});

const WEB_APP_API_KEY = process.env.MCP_SERVER_API_KEY_FOR_WEBAPP;

// Middleware for API Key Authentication
const authenticateApiKey: RequestHandler = (req, res, next) => {
if (!WEB_APP_API_KEY) {
  // If no key is set in .env, for development, we might allow requests.
  // In production, this should be a hard failure.
  console.warn("Warning: MCP_SERVER_API_KEY_FOR_WEBAPP is not set. API is currently unsecured for development.");
  next();
  return;
}
const authHeader = req.headers.authorization;
if (!authHeader || !authHeader.startsWith('Bearer ')) {
  res.status(401).json({ error: "Unauthorized: Missing or malformed Authorization header. Expected 'Bearer <token>'." });
  return;
}
const token = authHeader.split(' ')[1];
if (token !== WEB_APP_API_KEY) {
  res.status(401).json({ error: "Unauthorized: Invalid API key." });
  return;
}
next();
};

// llmConfigRouter.use('/', authenticateApiKey); // Apply auth to all llm-config routes, explicitly providing base path

// 1. Create a New LLM Configuration
const createLlmConfigHandler: RequestHandler = async (req, res, _next) => {
  console.log("createLlmConfigHandler: Entered");
  console.log("createLlmConfigHandler: Request body:", JSON.stringify(req.body));
  const { provider, model } = req.body;

  if (!provider || !model) {
    res.status(400).json({ error: "Missing required fields: provider and model are required." });
    return;
  }
  if (typeof provider !== 'string' || typeof model !== 'string') {
    res.status(400).json({ error: "Invalid data types for provider or model." });
    return;
  }

  const newConfigId = randomUUID(); // from 'crypto' import
  const currentTime = new Date().toISOString();

  try {
    console.log("createLlmConfigHandler: Attempting to insert:", newConfigId, provider, model);
    await new Promise<void>((resolve, reject) => {
      db.run(
        `INSERT INTO llm_configurations (id, provider, model, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newConfigId, provider, model, false, currentTime, currentTime],
        function (this: sqlite3.RunResult, err) {
          if (err) {
            console.error("Error inserting LLM configuration:", err);
            reject(err); // Ensure promise is rejected on error
            return;
          }
          console.log("createLlmConfigHandler: Insert successful for ID:", newConfigId);
          resolve();
        }
      );
    });

    // Fetch the newly created record to return it
    console.log("createLlmConfigHandler: Attempting to fetch new record for ID:", newConfigId);
    const newRecord = await new Promise<any>((resolve, reject) => {
        db.get("SELECT id, provider, model, is_active, created_at, updated_at FROM llm_configurations WHERE id = ?", [newConfigId], (err, row) => {
            if (err) {
                reject(err); // Ensure promise is rejected on error
                return;
            }
            console.log("createLlmConfigHandler: Fetched new record:", JSON.stringify(row));
            resolve(row);
        });
    });

    if (!newRecord) {
        // This should ideally not happen if the insert was successful
        console.error(`Failed to retrieve LLM configuration after insert for ID: ${newConfigId}`);
        res.status(500).json({ error: "Failed to retrieve the created LLM configuration." });
        return;
    }
    
    const expectedEnvVarName = `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    // Log the action and remind about setting the actual API key in environment
    console.log(`Created new LLM config: ID=${newConfigId}, Provider=${provider}, Model=${model}`);
    console.warn(`ACTION REQUIRED: To use this configuration, ensure the environment variable "${expectedEnvVarName}" is set with the actual API key value in your .env file.`);

    const responsePayload = { ...newRecord, message: `Configuration for ${provider} saved. Ensure ${expectedEnvVarName} is set in your .env file.` };
    console.log("createLlmConfigHandler: Sending 201 response with:", JSON.stringify(responsePayload));
    res.status(201).json(responsePayload);
  } catch (error: any) {
    console.error("createLlmConfigHandler: CAUGHT ERROR:", error, error.stack);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};

llmConfigRouter.post('/', createLlmConfigHandler);

// 2. Get All LLM Configurations
const getAllLlmConfigsHandler: RequestHandler = async (_req, res) => {
  try {
    const userConfigs = await new Promise<any[]>((resolve, reject) => {
      db.all("SELECT id, provider, model, is_active, created_at, updated_at FROM llm_configurations ORDER BY created_at DESC", (err, rows) => {
        if (err) {
          console.error("Error fetching LLM configurations:", err);
          reject(err);
          return;
        }
        resolve(rows);
      });
    });

    const isAnyUserConfigActive = userConfigs.some(c => c.is_active === 1 || c.is_active === true);

    const defaultServerConfig = {
        id: 'SERVER_DEFAULT_CONFIG',
        provider: DEFAULT_LLM_PROVIDER,
        model: DEFAULT_LLM_MODEL,
        // The default is considered "active" for display if no other user config is explicitly active.
        // Actual server usage of default relies on getLlmConfigAndKey fallback.
        is_active: !isAnyUserConfigActive,
        created_at: 'N/A',
        updated_at: 'N/A',
        is_default: true,
        is_immutable: true // This means it cannot be deleted by user. Activation is handled specially.
    };

    const allConfigsToReturn = [defaultServerConfig, ...userConfigs];
    res.status(200).json(allConfigsToReturn);
  } catch (error: any) {
    console.error("Error in GET /api/llm-config:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};

llmConfigRouter.get('/', getAllLlmConfigsHandler);

// 3. Get a Specific LLM Configuration
const getLlmConfigByIdHandler: RequestHandler = async (req, res) => {
  const { id } = req.params;
  try {
    const row = await new Promise<any>((resolve, reject) => {
      db.get("SELECT id, provider, model, is_active, created_at, updated_at FROM llm_configurations WHERE id = ?", [id], (err, row) => {
        if (err) {
          console.error(`Error fetching LLM configuration with ID ${id}:`, err);
          reject(err);
          return;
        }
        resolve(row);
      });
    });

    if (row) {
      res.status(200).json(row);
    } else {
      res.status(404).json({ error: `LLM Configuration with ID ${id} not found.` });
    }
  } catch (error: any) {
    console.error(`Error in GET /api/llm-config/${id}:`, error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};

llmConfigRouter.get('/:id', getLlmConfigByIdHandler);

// 4. Update an Existing LLM Configuration
const updateLlmConfigHandler: RequestHandler = async (req, res) => {
  const { id } = req.params;
  const { provider, model } = req.body; // Only allow updating provider and model here

  if (!provider && !model) {
    res.status(400).json({ error: "Missing fields to update: provider or model is required." });
    return;
  }

  const fieldsToUpdate: { key: string, value: any }[] = [];
  if (provider) fieldsToUpdate.push({ key: "provider", value: provider });
  if (model) fieldsToUpdate.push({ key: "model", value: model });
  
  fieldsToUpdate.push({ key: "updated_at", value: new Date().toISOString() });

  const setClauses = fieldsToUpdate.map(field => `${field.key} = ?`).join(', ');
  const values = fieldsToUpdate.map(field => field.value);
  values.push(id); // For the WHERE clause

  try {
    const result = await new Promise<{ changes: number }>((resolve, reject) => {
      db.run(`UPDATE llm_configurations SET ${setClauses} WHERE id = ?`, values, function (this: sqlite3.RunResult, err) {
        if (err) {
          console.error(`Error updating LLM configuration with ID ${id}:`, err);
          reject(err);
          return;
        }
        resolve({ changes: this.changes });
      });
    });

    if (result.changes === 0) {
      res.status(404).json({ error: `LLM Configuration with ID ${id} not found.` });
      return;
    }

    // Fetch and return the updated record
    const updatedRecord = await new Promise<any>((resolve, reject) => {
      db.get("SELECT id, provider, model, is_active, created_at, updated_at FROM llm_configurations WHERE id = ?", [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    res.status(200).json(updatedRecord);

  } catch (error: any) {
    console.error(`Error in PUT /api/llm-config/${id}:`, error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};

llmConfigRouter.put('/:id', updateLlmConfigHandler);

// 5. Activate an LLM Configuration (User-defined or Server Default)
const activateLlmConfigHandler: RequestHandler = async (req, res) => {
  const { id } = req.params;
  const currentTime = new Date().toISOString();

  try {
    if (id === 'SERVER_DEFAULT_CONFIG') {
      // Activating the server default means deactivating all user-defined configs
      await new Promise<void>((resolve, reject) => {
        db.run("UPDATE llm_configurations SET is_active = FALSE, updated_at = ? WHERE is_active = TRUE", [currentTime], (err) => {
          if (err) {
            console.error("Error deactivating user LLM configurations for default activation:", err);
            return reject(err);
          }
          console.log("All user LLM configurations deactivated. Server default is now effectively active.");
          resolve();
        });
      });
      // Return a representation of the default config as if it were an activated record
      res.status(200).json({
        id: 'SERVER_DEFAULT_CONFIG',
        provider: DEFAULT_LLM_PROVIDER,
        model: DEFAULT_LLM_MODEL,
        is_active: true, // Signifying default is now the one to be used
        created_at: 'N/A',
        updated_at: currentTime,
        is_default: true,
        is_immutable: true,
        message: "Server default LLM configuration activated."
      });
    } else {
      // Activating a specific user-defined configuration
      await new Promise<void>((resolve, reject) => {
        db.serialize(() => {
          db.run("BEGIN TRANSACTION;", (errBegin) => {
            if (errBegin) return reject(errBegin);

            db.run("UPDATE llm_configurations SET is_active = FALSE, updated_at = ? WHERE is_active = TRUE", [currentTime], (errUpdateAll) => {
              if (errUpdateAll) {
                db.run("ROLLBACK;", () => reject(errUpdateAll));
                return;
              }
              db.run("UPDATE llm_configurations SET is_active = TRUE, updated_at = ? WHERE id = ?", [currentTime, id], function (this: sqlite3.RunResult, errUpdateOne) {
                if (errUpdateOne) {
                  db.run("ROLLBACK;", () => reject(errUpdateOne));
                  return;
                }
                if (this.changes === 0) {
                  db.run("ROLLBACK;", () => reject(new Error(`LLM Configuration with ID ${id} not found for activation.`)));
                  return;
                }
                db.run("COMMIT;", (errCommit) => {
                  if (errCommit) return reject(errCommit);
                  resolve();
                });
              });
            });
          });
        });
      });

      const activatedRecord = await new Promise<any>((resolve, reject) => {
        db.get("SELECT id, provider, model, is_active, created_at, updated_at FROM llm_configurations WHERE id = ?", [id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      
      if (!activatedRecord) {
        res.status(404).json({ error: `LLM Configuration with ID ${id} not found post-activation attempt.` });
        return;
      }
      console.log(`Activated user LLM config: ID=${id}.`);
      res.status(200).json(activatedRecord);
    }
  } catch (error: any) {
    console.error(`Error in PATCH /api/llm-config/${id}/activate:`, error);
    if (error.message && error.message.includes("not found for activation")) {
        res.status(404).json({ error: error.message });
    } else {
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
  }
};

llmConfigRouter.patch('/:id/activate', activateLlmConfigHandler);

// NEW: Delete All LLM Configurations
const deleteAllLlmConfigsHandler: RequestHandler = async (_req, res) => {
  console.log("deleteAllLlmConfigsHandler: Entered");
  try {
    console.log("deleteAllLlmConfigsHandler: Attempting to delete all llm_configurations");
    await new Promise<void>((resolve, reject) => {
      db.run("DELETE FROM llm_configurations;", function (this: sqlite3.RunResult, err) {
        if (err) {
          console.error("Error deleting all LLM configurations:", err);
          reject(err);
          return;
        }
        console.log(`deleteAllLlmConfigsHandler: Deletion successful. Rows affected: ${this.changes}`);
        resolve();
      });
    });
    console.log("deleteAllLlmConfigsHandler: Sending 204 response");
    res.status(204).send(); // No Content
  } catch (error: any) {
    console.error("deleteAllLlmConfigsHandler: CAUGHT ERROR:", error, error.stack);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};

// 6. Delete an LLM Configuration
const deleteLlmConfigHandler: RequestHandler = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await new Promise<{ changes: number }>((resolve, reject) => {
      db.run("DELETE FROM llm_configurations WHERE id = ?", [id], function (this: sqlite3.RunResult, err) {
        if (err) {
          console.error(`Error deleting LLM configuration with ID ${id}:`, err);
          reject(err);
          return;
        }
        resolve({ changes: this.changes });
      });
    });

    if (result.changes === 0) {
      res.status(404).json({ error: `LLM Configuration with ID ${id} not found.` });
      return;
    }
    // TODO: If the deleted config was active, logic-mcp should revert to a default or no LLM.
    // This might involve a hot-reload trigger or a check on next LLM use.
    console.log(`Deleted LLM config: ID=${id}. Active config status needs re-evaluation by server.`);
    res.status(204).send(); // No Content

  } catch (error: any) {
    console.error(`Error in DELETE /api/llm-config/${id}:`, error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};

// Ensure '/all' is registered before '/:id'
llmConfigRouter.delete('/all', deleteAllLlmConfigsHandler);
llmConfigRouter.delete('/:id', deleteLlmConfigHandler);

// 7. Webhook for Hot-Reloading (Internal)
const reloadLlmConfigHandler: RequestHandler = async (_req, res) => {
  // TODO: Implement the actual hot-reloading logic within the MCP server.
  // This would involve:
  // 1. Re-querying the active configuration from `llm_configurations`.
  // 2. Re-retrieving the API key from the environment (based on the new api_key_id).
  // 3. Re-initializing or updating the LLM client instance (e.g., the axios setup for OpenRouter).
  console.log("Received request to /api/llm-config/reload. Hot-reload mechanism to be implemented.");
  res.status(200).json({ status: "success", message: "LLM configuration reload initiated (stub)." });
};

llmConfigRouter.post('/reload', reloadLlmConfigHandler);

app.use('/api/llm-config', llmConfigRouter);

// --- API Routes for Logic Explorer ---
const logicExplorerRouter: Router = express.Router();
logicExplorerRouter.use(authenticateApiKey); // Reuse the same authentication

// 1. List All Logic Chains
interface LogicChainSummaryRow {
  chain_id: string;
  chain_name: string | null; // Added
  description: string | null;
  root_operation_uuid: string | null;
  created_at: string;
  operation_count: number;
}

const listAllLogicChainsHandler: RequestHandler = async (_req, res) => {
  try {
    const chains = await new Promise<LogicChainSummaryRow[]>((resolve, reject) => {
      // Query to get chain details and count of operations in each chain
      const sql = `
        SELECT
          lc.chain_id,
          lc.chain_name, -- Added
          lc.description,
          op_root.operation_id as root_operation_uuid,
          lc.created_at,
          (SELECT COUNT(*) FROM operations ops WHERE json_extract(ops.context, '$.chain_id') = lc.chain_id) as operation_count
        FROM logic_chains lc
        LEFT JOIN operations op_root ON lc.root_operation = op_root.id
        ORDER BY lc.created_at DESC
      `;
      db.all(sql, (err, rows: LogicChainSummaryRow[]) => {
        if (err) {
          console.error("Error fetching logic chains:", err);
          return reject(err);
        }
        // Map to ensure the output field name matches the design doc if different from query alias
        resolve(rows.map(row => ({
            chain_id: row.chain_id,
            chain_name: row.chain_name, // Added
            description: row.description,
            root_operation_uuid: row.root_operation_uuid || null,
            created_at: row.created_at,
            operation_count: row.operation_count
        })));
      });
    });
    res.status(200).json(chains);
  } catch (error: any) {
    console.error("Error in GET /api/logic-explorer/chains:", error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};
logicExplorerRouter.get('/chains', listAllLogicChainsHandler);

// Helper function to parse JSON safely
const safeJsonParse = (jsonString: string | null, defaultValue: any = null) => {
  if (!jsonString) return defaultValue;
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.warn("Failed to parse JSON string:", jsonString, e);
    return defaultValue; // Or return the original string if preferred
  }
};

// 2. Get a Specific Logic Chain with its Operations
interface OperationDetail {
    operation_id: string;
    operation_name: string | null; // Added
    primitive_name: string;
    input_data: any;
    output_data: any;
    status: string;
    start_time: string;
    end_time: string | null;
    context: any;
    parent_operation_uuids: string[];
    child_operation_uuids: string[];
    // For internal use during construction
    db_id?: number;
}

const getChainWithOperationsHandler: RequestHandler = async (req, res) => {
  const { chainId } = req.params;
  try {
    // 1. Fetch chain details
    const chainDetails = await new Promise<any>((resolve, reject) => {
      db.get(`
        SELECT lc.chain_id, lc.chain_name, lc.description, op_root.operation_id as root_operation_uuid, lc.created_at
        FROM logic_chains lc
        LEFT JOIN operations op_root ON lc.root_operation = op_root.id
        WHERE lc.chain_id = ?
      `, [chainId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!chainDetails) {
      res.status(404).json({ error: `Logic Chain with ID ${chainId} not found.` });
      return;
    }

    // 2. Fetch all operations for this chain
    const operationsRaw = await new Promise<any[]>((resolve, reject) => {
      db.all(`
        SELECT id as db_id, operation_id, operation_name, primitive_name, input_data, output_data, status, start_time, end_time, context
        FROM operations
        WHERE json_extract(context, '$.chain_id') = ?
        ORDER BY start_time ASC
      `, [chainId], (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });

    const operationsMap = new Map<string, OperationDetail>();
    const dbIdToUuidMap = new Map<number, string>();

    const processedOperations: OperationDetail[] = operationsRaw.map(op => {
      const detail: OperationDetail = {
        db_id: op.db_id,
        operation_id: op.operation_id,
        operation_name: op.operation_name, // Added
        primitive_name: op.primitive_name,
        input_data: safeJsonParse(op.input_data, {}),
        output_data: safeJsonParse(op.output_data, {}),
        status: op.status,
        start_time: op.start_time,
        end_time: op.end_time,
        context: safeJsonParse(op.context, {}),
        parent_operation_uuids: [],
        child_operation_uuids: []
      };
      operationsMap.set(op.operation_id, detail);
      dbIdToUuidMap.set(op.db_id, op.operation_id);
      return detail;
    });
    
    // 3. Fetch all relationships for the operations in this chain
    const operationDbIds = operationsRaw.map(op => op.db_id);
    if (operationDbIds.length > 0) {
        const placeholders = operationDbIds.map(() => '?').join(',');
        const relationships = await new Promise<any[]>((resolve, reject) => {
            db.all(`
                SELECT parent_id, child_id
                FROM operation_relationships
                WHERE parent_id IN (${placeholders}) OR child_id IN (${placeholders})
            `, [...operationDbIds, ...operationDbIds], (err, relRows) => { // Pass IDs twice for OR condition
                if (err) return reject(err);
                resolve(relRows);
            });
        });

        relationships.forEach(rel => {
            const parentUuid = dbIdToUuidMap.get(rel.parent_id);
            const childUuid = dbIdToUuidMap.get(rel.child_id);

            if (parentUuid && childUuid) {
                const parentOp = operationsMap.get(parentUuid);
                const childOp = operationsMap.get(childUuid);

                if (parentOp && !parentOp.child_operation_uuids.includes(childUuid)) {
                    parentOp.child_operation_uuids.push(childUuid);
                }
                if (childOp && !childOp.parent_operation_uuids.includes(parentUuid)) {
                    childOp.parent_operation_uuids.push(parentUuid);
                }
            }
        });
    }
    
    // Remove db_id before sending response
    const finalOperations = processedOperations.map(({ db_id, ...rest}) => rest);

    res.status(200).json({
      chain_id: chainDetails.chain_id,
      chain_name: chainDetails.chain_name, // Added
      description: chainDetails.description,
      root_operation_id: chainDetails.root_operation_uuid || null,
      created_at: chainDetails.created_at,
      operations: finalOperations
    });
    // Implicit return here, making the promise resolve to void

  } catch (error: any) {
    console.error(`Error in GET /api/logic-explorer/chains/${chainId}:`, error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
    // Implicit return here
  }
};
logicExplorerRouter.get('/chains/:chainId', getChainWithOperationsHandler);

// 3. Get Details for a Specific Operation
const getOperationDetailsHandler: RequestHandler = async (req, res) => {
  const { operationId } = req.params;
  try {
    // 1. Fetch operation details
    const operationRaw = await new Promise<any>((resolve, reject) => {
      db.get(`
        SELECT id as db_id, operation_id, operation_name, primitive_name, input_data, output_data, status, start_time, end_time, context
        FROM operations
        WHERE operation_id = ?
      `, [operationId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!operationRaw) {
      res.status(404).json({ error: `Operation with ID ${operationId} not found.` });
      return;
    }

    const operationDetail: OperationDetail = {
      db_id: operationRaw.db_id,
      operation_id: operationRaw.operation_id,
      operation_name: operationRaw.operation_name, // Added missing field
      primitive_name: operationRaw.primitive_name,
      input_data: safeJsonParse(operationRaw.input_data, {}),
      output_data: safeJsonParse(operationRaw.output_data, {}),
      status: operationRaw.status,
      start_time: operationRaw.start_time,
      end_time: operationRaw.end_time,
      context: safeJsonParse(operationRaw.context, {}),
      parent_operation_uuids: [],
      child_operation_uuids: []
    };

    // 2. Fetch relationships
    const relationships = await new Promise<any[]>((resolve, reject) => {
      db.all(`
        SELECT parent_id, child_id
        FROM operation_relationships
        WHERE parent_id = ? OR child_id = ?
      `, [operationRaw.db_id, operationRaw.db_id], (err, relRows) => {
        if (err) return reject(err);
        resolve(relRows);
      });
    });

    const parentDbIds = new Set<number>();
    const childDbIds = new Set<number>();

    relationships.forEach(rel => {
      if (rel.child_id === operationRaw.db_id) {
        parentDbIds.add(rel.parent_id);
      }
      if (rel.parent_id === operationRaw.db_id) {
        childDbIds.add(rel.child_id);
      }
    });

    // Fetch UUIDs for parent and child db_ids
    if (parentDbIds.size > 0) {
      const parentPlaceholders = Array.from(parentDbIds).map(() => '?').join(',');
      const parentOps = await new Promise<any[]>((resolve, reject) => {
        db.all(`SELECT operation_id FROM operations WHERE id IN (${parentPlaceholders})`, Array.from(parentDbIds), (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        });
      });
      operationDetail.parent_operation_uuids = parentOps.map(op => op.operation_id);
    }

    if (childDbIds.size > 0) {
      const childPlaceholders = Array.from(childDbIds).map(() => '?').join(',');
      const childOps = await new Promise<any[]>((resolve, reject) => {
        db.all(`SELECT operation_id FROM operations WHERE id IN (${childPlaceholders})`, Array.from(childDbIds), (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        });
      });
      operationDetail.child_operation_uuids = childOps.map(op => op.operation_id);
    }
    
    // Remove db_id before sending response
    const { db_id, ...finalOperationDetail } = operationDetail;

    res.status(200).json(finalOperationDetail);

  } catch (error: any) {
    console.error(`Error in GET /api/logic-explorer/operations/${operationId}:`, error);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};
logicExplorerRouter.get('/operations/:operationId', getOperationDetailsHandler);

// 4. Get Operation Relationships (Parents/Children)
interface OperationRelationshipSummary {
    operation_id: string;
    operation_name: string | null; // Added
    primitive_name: string;
}
const getOperationRelationshipsHandler: RequestHandler = async (req, res) => {
    const { operationId } = req.params;
    try {
        // 1. Get the db_id for the given operation_id
        const currentOpDbRow = await new Promise<{ id: number } | undefined>((resolve, reject) => {
            db.get("SELECT id FROM operations WHERE operation_id = ?", [operationId], (err, row: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });

        if (!currentOpDbRow) {
            res.status(404).json({ error: `Operation with ID ${operationId} not found.` });
            return;
        }
        const currentOpDbId = currentOpDbRow.id;

        // 2. Fetch parent relationships (operations that are parents to currentOpDbId)
        const parentRels = await new Promise<OperationRelationshipSummary[]>((resolve, reject) => {
            db.all(`
                SELECT o.operation_id, o.operation_name, o.primitive_name
                FROM operation_relationships rel
                JOIN operations o ON rel.parent_id = o.id
                WHERE rel.child_id = ?
            `, [currentOpDbId], (err, rows: any[]) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows.map(r => ({ operation_id: r.operation_id, operation_name: r.operation_name, primitive_name: r.primitive_name })));
            });
        });
        
        // 3. Fetch child relationships (operations that are children of currentOpDbId)
        const childRels = await new Promise<OperationRelationshipSummary[]>((resolve, reject) => {
            db.all(`
                SELECT o.operation_id, o.operation_name, o.primitive_name
                FROM operation_relationships rel
                JOIN operations o ON rel.child_id = o.id
                WHERE rel.parent_id = ?
            `, [currentOpDbId], (err, rows: any[]) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows.map(r => ({ operation_id: r.operation_id, operation_name: r.operation_name, primitive_name: r.primitive_name })));
            });
        });

        res.status(200).json({
            operation_id: operationId,
            parents: parentRels,
            children: childRels
        });

    } catch (error: any) {
        console.error(`Error in GET /api/logic-explorer/operations/${operationId}/relationships:`, error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
};
logicExplorerRouter.get('/operations/:operationId/relationships', getOperationRelationshipsHandler);

// NEW: Delete All Logic Chains and Related Data
const deleteAllLogicChainsHandler: RequestHandler = async (_req, res) => {
  try {
    await new Promise<void>((resolve, reject) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION;", (errBegin) => {
          if (errBegin) return reject(errBegin);

          db.run("DELETE FROM operation_relationships;", function (this: sqlite3.RunResult, errRel) {
            if (errRel) {
              console.error("Error deleting from operation_relationships:", errRel);
              db.run("ROLLBACK;", () => reject(errRel));
              return;
            }
            console.log(`Deleted from operation_relationships. Rows affected: ${this.changes}`);

            db.run("DELETE FROM operations;", function (this: sqlite3.RunResult, errOps) {
              if (errOps) {
                console.error("Error deleting from operations:", errOps);
                db.run("ROLLBACK;", () => reject(errOps));
                return;
              }
              console.log(`Deleted from operations. Rows affected: ${this.changes}`);

              db.run("DELETE FROM logic_chains;", function (this: sqlite3.RunResult, errChains) {
                if (errChains) {
                  console.error("Error deleting from logic_chains:", errChains);
                  db.run("ROLLBACK;", () => reject(errChains));
                  return;
                }
                console.log(`Deleted from logic_chains. Rows affected: ${this.changes}`);

                db.run("COMMIT;", (errCommit) => {
                  if (errCommit) {
                    console.error("Error committing transaction:", errCommit);
                    return reject(errCommit);
                  }
                  console.log("All logic chains and related operations deleted successfully.");
                  resolve();
                });
              });
            });
          });
        });
      });
    });
    res.status(204).send(); // No Content
  } catch (error: any) {
    console.error("Error in DELETE /api/logic-explorer/chains/all:", error);
    // Ensure rollback is attempted if transaction was started and error occurred before commit/rollback
    // This is a bit tricky here as the promise might reject before db.run("ROLLBACK") is called from within.
    // For simplicity, we rely on the catch within the promise to handle rollback.
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
};

logicExplorerRouter.delete('/chains/all', deleteAllLogicChainsHandler);

app.use('/api/logic-explorer', logicExplorerRouter);
// --- Tool Input Schema ---
const executeLogicOperationInputSchema = z.object({
  chain_id: z.string().uuid().optional().describe("ID of the logic chain. If not provided, a new chain is created and its ID returned."),
  chain_name: z.string().optional().describe("Optional human-readable name for a new chain if chain_id is not provided."),
  parent_operation_id: z.string().uuid().optional().describe("ID of the parent operation in this chain, for explicit sequencing. Helps build the execution graph."),
  operation_name: z.string().optional().describe("Optional human-readable name for this specific operation."),
  branch_id: z.string().optional().describe("Identifier for a parallel branch of logic within the same chain. Operations with the same branch_id form a sequence within that branch."),
  operation: operationSchema,
}).describe("Input for executing a single step in a logic chain.");

// --- MCP Server Setup ---
// In-memory state (active_chains, OperationRecord, LogicChain) is now removed.
// State will be managed in SQLite.
const server = new McpServer({
  name: "logic-mcp",
  version: "0.1.0",
  description: "A server for advanced logic primitives and cognitive operations, inspired by sequentialthinking and previous logic-mcp-primitives."
});

server.tool(
  "execute_logic_operation",
  executeLogicOperationInputSchema.shape, // Use .shape for ZodRawShape
  { // Annotations object
    title: "Execute Logic Operation",
    description: "Executes a single operation within a logic chain, or starts a new chain. Supports various cognitive primitives."
  },
  async (params) => {
    const operationIdUUID = randomUUID(); // This is the public UUID for the operation
    const startTime = new Date().toISOString();

    // Helper function to get active LLM config and API key
    const getLlmConfigAndKey = async () => {
      // 1. Try to get user-defined active config
      const userActiveConfig = await new Promise<{ provider: string; model: string } | undefined>((resolve, reject) => {
        db.get("SELECT provider, model FROM llm_configurations WHERE is_active = TRUE", (err, row: any) => {
          if (err) return reject(err); // DB query error
          resolve(row); // row will be undefined if no active config
        });
      });

      if (userActiveConfig) {
        // User has an active config, try to use it
        console.log(`Using active user LLM configuration: ${userActiveConfig.provider} - ${userActiveConfig.model}`);
        const expectedEnvVarName = `${userActiveConfig.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        const actualApiKey = process.env[expectedEnvVarName];
        if (!actualApiKey) {
          throw new Error(`Environment variable ${expectedEnvVarName} for active config '${userActiveConfig.provider}/${userActiveConfig.model}' is not set. Please set it in the .env file.`);
        }
        return { activeConfig: { provider: userActiveConfig.provider, model: userActiveConfig.model }, actualApiKey };
      } else {
        // No user-defined active config, fall back to server default
        console.log("No active user LLM configuration found. Attempting to use server default.");
        const defaultProvider = DEFAULT_LLM_PROVIDER;
        const defaultModel = DEFAULT_LLM_MODEL;
        const expectedDefaultEnvVarName = `${defaultProvider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        const actualDefaultApiKey = process.env[expectedDefaultEnvVarName];

        if (!actualDefaultApiKey) {
          throw new Error(`No active user LLM configuration, and the default server configuration (provider: ${defaultProvider}) requires environment variable ${expectedDefaultEnvVarName} which is not set.`);
        }
        console.log(`Using server default LLM configuration: ${defaultProvider} - ${defaultModel}`);
        return { activeConfig: { provider: defaultProvider, model: defaultModel }, actualApiKey: actualDefaultApiKey };
      }
      // The outer try/catch in execute_logic_operation will handle errors thrown from here.
    };
    let operationOutput: any = { message: "Operation processed (stub)." };
    let operationStatus: "success" | "failure" = "success";
    let errorMessage: string | undefined;
    let currentChainId = params.chain_id;
    let isNewChain = false;
    let finalChainName: string | null = null; // Declare here

    try {
      // 1. Ensure chain exists or create it
      if (!currentChainId) {
        isNewChain = true;
        const newChainUUID = randomUUID(); // Generate UUID first
        currentChainId = newChainUUID;     // Assign to currentChainId, now it's definitely a string

        // Define default operation name, potentially used in default chain name
        const defaultOperationNameForChain = params.operation_name || `${params.operation.type.charAt(0).toUpperCase() + params.operation.type.slice(1)} Operation No. ${operationIdUUID.substring(0, 4)}`;
        // Use newChainUUID for safety in string interpolation as currentChainId's type might not be narrowed yet by TS for this line
        const chainName = params.chain_name || `Chain started with ${defaultOperationNameForChain} (${newChainUUID.substring(0,4)})`;
        const chainDescription = `Chain initiated by a '${params.operation.type}' operation.`;

        await new Promise<void>((resolve, reject) => {
          db.run(
            "INSERT INTO logic_chains (chain_id, chain_name, description, created_at) VALUES (?, ?, ?, ?)",
            [newChainUUID, chainName, chainDescription, startTime], // Use newChainUUID for insertion
            (err) => {
              if (err) {
                console.error("Error creating new chain:", err);
                return reject(err);
              }
              resolve();
            }
          );
        });
        finalChainName = chainName; // Assign the newly generated/provided chainName
      } else {
        // Verify chain exists and fetch its name
        const chainRow = await new Promise<any>((resolve, reject) => {
          db.get("SELECT chain_id, chain_name FROM logic_chains WHERE chain_id = ?", [currentChainId], (err, row) => {
            if (err) {
              console.error("Error verifying chain:", err);
              return reject(err);
            }
            resolve(row);
          });
        });
        if (!chainRow) {
          return {
            content: [{ type: "text", text: `Error: Chain with ID ${currentChainId} not found.` }],
            isError: true,
          };
        }
        finalChainName = chainRow.chain_name; // Assign the fetched chain name
      }

      // 2. Basic dispatch logic (stubbed implementations)
      // The operationIdUUID is used in the output for consistency if needed by client
      switch (params.operation.type) {
        case "observe":
          operationOutput = { observation_id: operationIdUUID, data_summary: `Observed: ${params.operation.params.source_description}`, raw_data_preview: params.operation.params.raw_data ? String(params.operation.params.raw_data).substring(0,100) : "N/A" };
          break;
        case "define":
          try {
            const { activeConfig, actualApiKey } = await getLlmConfigAndKey();
            let contextData = "";
            
            // Fetch observation data if IDs are provided
            if (params.operation.params.based_on_observation_ids && params.operation.params.based_on_observation_ids.length > 0) {
              for (const obsId of params.operation.params.based_on_observation_ids) {
                const row = await new Promise<any>((resolve, reject) => {
                  db.get("SELECT output_data FROM operations WHERE operation_id = ?", [obsId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                  });
                });
                
                if (row && row.output_data) {
                  try {
                    const parsedOutput = JSON.parse(row.output_data);
                    contextData += `Observation (ID: ${obsId}): ${JSON.stringify(parsedOutput)}\n\n`;
                  } catch (e) {
                    contextData += `Observation (ID: ${obsId}): ${row.output_data.substring(0, 200)}...\n\n`;
                  }
                }
              }
            }
            
            // Build the prompt
            const conceptName = params.operation.params.concept_name;
            const descriptionPart = params.operation.params.description ? `Description: ${params.operation.params.description}\n` : '';
            const fullPrompt = `Define the concept: '${conceptName}'\n\n${descriptionPart}${contextData}Please provide a comprehensive definition:`;
            
            let llmApiResponse: any;

            if (activeConfig.provider === "gemini") {
              const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeConfig.model}:generateContent?key=${actualApiKey}`;
              const geminiPayload = {
                contents: [{
                  parts: [{ text: fullPrompt }]
                }]
                // TODO: Add system instruction if Gemini API supports it directly in this structure,
                // or prepend it to the user's fullPrompt if necessary.
                // For now, system instruction "You are a helpful assistant..." is omitted for direct Gemini.
              };
              console.log(`Define with Gemini: URL=${geminiApiUrl}, Payload=${JSON.stringify(geminiPayload)}`);
              llmApiResponse = await axios.post(geminiApiUrl, geminiPayload, {
                headers: { "Content-Type": "application/json" },
              });

              if (llmApiResponse.data && llmApiResponse.data.candidates && llmApiResponse.data.candidates.length > 0 &&
                  llmApiResponse.data.candidates[0].content && llmApiResponse.data.candidates[0].content.parts &&
                  llmApiResponse.data.candidates[0].content.parts.length > 0) {
                operationOutput = {
                  definition_id: operationIdUUID,
                  concept_defined: conceptName,
                  generated_definition: llmApiResponse.data.candidates[0].content.parts[0].text,
                  based_on_observations: params.operation.params.based_on_observation_ids || [],
                  model_used: `gemini/${activeConfig.model}`, // Indicate Gemini was used
                  api_response_id: "N/A for direct Gemini in this format" // Gemini API response structure is different
                };
              } else {
                operationStatus = "failure";
                errorMessage = "Define operation with Gemini failed: No response or unexpected format.";
                operationOutput = { message: errorMessage, details: llmApiResponse.data };
              }

            } else { // Default to OpenRouter or other compatible providers
              console.log(`Define with ${activeConfig.provider}: URL=${OPENROUTER_API_URL}, Model=${activeConfig.model}`);
              llmApiResponse = await axios.post(
                OPENROUTER_API_URL,
                {
                  model: activeConfig.model,
                  messages: [
                    { role: "system", content: "You are a helpful assistant that provides clear, concise definitions of concepts." },
                    { role: "user", content: fullPrompt }
                  ],
                },
                {
                  headers: {
                    "Authorization": `Bearer ${actualApiKey}`,
                    "Content-Type": "application/json",
                  },
                }
              );

              if (llmApiResponse.data && llmApiResponse.data.choices && llmApiResponse.data.choices.length > 0) {
                operationOutput = {
                  definition_id: operationIdUUID,
                  concept_defined: conceptName,
                  generated_definition: llmApiResponse.data.choices[0].message.content,
                  based_on_observations: params.operation.params.based_on_observation_ids || [],
                  model_used: llmApiResponse.data.model, // Model from OpenRouter response
                  api_response_id: llmApiResponse.data.id
                };
              } else {
                operationStatus = "failure";
                errorMessage = "Define operation failed: No response from LLM or unexpected format.";
                operationOutput = { message: errorMessage, details: llmApiResponse.data };
              }
            }
          } catch (apiError: any) {
            operationStatus = "failure";
            if (axios.isAxiosError(apiError)) {
              errorMessage = `Define operation API error: ${apiError.response?.status} ${apiError.response?.data?.error?.message || apiError.message}`;
              operationOutput = { message: errorMessage, details: apiError.response?.data };
            } else {
              errorMessage = `Define operation failed: ${apiError.message}`;
              operationOutput = { message: errorMessage };
            }
            console.error(errorMessage, apiError);
          }
          break;
        case "infer":
          try {
            const { activeConfig, actualApiKey } = await getLlmConfigAndKey();
            // Simplified premise handling: For now, just acknowledge them.
            // A full implementation would fetch and summarize content from these premise operations.
            let premiseContext = "";
            if (params.operation.params.premise_operation_ids && params.operation.params.premise_operation_ids.length > 0) {
                premiseContext = `Based on previous operations (IDs: ${params.operation.params.premise_operation_ids.join(', ')}), `;
            }

            const userPrompt = params.operation.params.prompt_or_query || "Perform a general inference.";
            const fullPrompt = premiseContext + userPrompt;

            const response = await axios.post(
              OPENROUTER_API_URL, // This might need to be dynamic if not using OpenRouter based on activeConfig.provider
              {
                model: activeConfig.model, // Use model from active config
                messages: [
                  { role: "system", content: "You are a helpful assistant performing a logical inference." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${actualApiKey}`, // Use actualApiKey from active config
                  "Content-Type": "application/json",
                  // Recommended by OpenRouter:
                  // "HTTP-Referer": `${YOUR_SITE_URL}`, // Consider making these dynamic or configurable if needed
                  // "X-Title": `${YOUR_SITE_NAME}`,      // Consider making these dynamic or configurable if needed
                },
              }
            );

            if (response.data && response.data.choices && response.data.choices.length > 0) {
              operationOutput = {
                inference_id: operationIdUUID,
                conclusion: response.data.choices[0].message.content,
                premises_used: params.operation.params.premise_operation_ids,
                model_used: response.data.model,
                api_response_id: response.data.id
              };
            } else {
              operationStatus = "failure";
              errorMessage = "Infer operation failed: No response from LLM or unexpected format.";
              operationOutput = { message: errorMessage, details: response.data };
            }
          } catch (apiError: any) {
            operationStatus = "failure";
            if (axios.isAxiosError(apiError)) {
              errorMessage = `Infer operation API error: ${apiError.response?.status} ${apiError.response?.data?.error?.message || apiError.message}`;
              operationOutput = { message: errorMessage, details: apiError.response?.data };
            } else {
              errorMessage = `Infer operation failed: ${apiError.message}`;
              operationOutput = { message: errorMessage };
            }
            console.error(errorMessage, apiError);
          }
          break;
        case "decide":
          const chosenOptionUUID = params.operation.params.option_operation_ids[0];
          let chosenOptionRetrievedOutput: any = "Could not retrieve chosen option output (stub or ID not found).";
          if (chosenOptionUUID) {
            const row = await new Promise<any>((resolve, reject) => {
              db.get("SELECT output_data FROM operations WHERE operation_id = ?", [chosenOptionUUID], (err, row) => {
                if (err) return reject(err);
                resolve(row);
              });
            });
            if (row && row.output_data) {
              try {
                chosenOptionRetrievedOutput = JSON.parse(row.output_data);
              } catch (parseError) {
                chosenOptionRetrievedOutput = `Failed to parse output_data for option ${chosenOptionUUID}: ${row.output_data}`;
              }
            } else {
               chosenOptionRetrievedOutput = `Output data for option ID ${chosenOptionUUID} not found.`;
            }
          }
          try {
            const { activeConfig, actualApiKey } = await getLlmConfigAndKey();
            // Ensure correct typing for decide operation parameters
            const decideSpecificParams = params.operation.params as z.infer<typeof decideParamsSchema>;

            let optionsContext = "Policy Options:\n";
            const optionContents: any[] = [];
            for (const optionId of decideSpecificParams.option_operation_ids) {
              const row = await new Promise<any>((resolve, reject) => {
                db.get("SELECT output_data, primitive_name FROM operations WHERE operation_id = ?", [optionId], (err, row) => {
                  if (err) return reject(err);
                  resolve(row);
                });
              });
              if (row && row.output_data) {
                let parsedContent = row.output_data;
                try { parsedContent = JSON.parse(row.output_data); } catch (e) { /* keep as string */ }
                optionContents.push({ id: optionId, content: parsedContent, type: row.primitive_name });
                optionsContext += `\n--- Option (ID: ${optionId}, Type: ${row.primitive_name}) ---\n${typeof parsedContent === 'string' ? parsedContent : JSON.stringify(parsedContent, null, 2)}\n--- End of Option ---\n`;
              } else {
                optionsContext += `\n--- Could not retrieve content for option ID: ${optionId} ---\n`;
              }
            }

            let criteriaContext = "Decision Criteria:\n";
            if (decideSpecificParams.criteria_operation_id) {
              const criteriaRow = await new Promise<any>((resolve, reject) => {
                db.get("SELECT output_data, primitive_name FROM operations WHERE operation_id = ?", [decideSpecificParams.criteria_operation_id], (err, row) => {
                  if (err) return reject(err);
                  resolve(row);
                });
              });
              if (criteriaRow && criteriaRow.output_data) {
                 let parsedContent = criteriaRow.output_data;
                try { parsedContent = JSON.parse(criteriaRow.output_data); } catch (e) { /* keep as string */ }
                criteriaContext += `--- Criteria (ID: ${decideSpecificParams.criteria_operation_id}, Type: ${criteriaRow.primitive_name}) ---\n${typeof parsedContent === 'string' ? parsedContent : JSON.stringify(parsedContent, null, 2)}\n--- End of Criteria ---\n`;
              } else {
                criteriaContext += `--- Could not retrieve content for criteria ID: ${decideSpecificParams.criteria_operation_id} ---\n`;
              }
            } else {
              criteriaContext += "No specific criteria operation ID provided.\n";
            }
            
            const chosenOptionIdForJustification = decideSpecificParams.option_operation_ids[0];
            // Ensure chosenOptionFullContent is robustly fetched or assigned
            let chosenOptionFullContent = optionContents.find(opt => opt.id === chosenOptionIdForJustification)?.content;
            if (chosenOptionFullContent === undefined) {
                const row = await new Promise<any>((resolve, reject) => db.get("SELECT output_data FROM operations WHERE operation_id = ?", [chosenOptionIdForJustification], (err, r) => err ? reject(err) : resolve(r)));
                if (row && row.output_data) {
                    try { chosenOptionFullContent = JSON.parse(row.output_data); } catch(e) { chosenOptionFullContent = row.output_data; }
                } else {
                    chosenOptionFullContent = "Chosen option content not found";
                }
            }

            const decisionPrompt = decideSpecificParams.decision_prompt;
            const decisionMethod = decideSpecificParams.decision_method || "general evaluation";
            
            const fullPrompt = `${optionsContext}\n${criteriaContext}\nDecision Prompt: ${decisionPrompt}\nDecision Method: ${decisionMethod}\n\nThe chosen option is ID: ${chosenOptionIdForJustification}. Please provide a detailed justification for why this option was chosen (or would be chosen) based on the provided criteria and decision method, explaining its strengths relative to other options (even if other options are not fully detailed here, infer their general nature if possible from the decision prompt).`;

            const llmResponse = await axios.post(
              OPENROUTER_API_URL, // Assuming OpenRouter URL for now, or make dynamic based on activeConfig.provider
              {
                model: activeConfig.model,
                messages: [
                  { role: "system", content: "You are a helpful assistant that provides justifications for decisions based on options and criteria." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${actualApiKey}`,
                  "Content-Type": "application/json",
                },
              }
            );

            let justificationText = "LLM Justification failed or not provided.";
            if (llmResponse.data && llmResponse.data.choices && llmResponse.data.choices.length > 0) {
              justificationText = llmResponse.data.choices[0].message.content;
            }

            operationOutput = {
              decision_id: operationIdUUID,
              chosen_option_id_internal: chosenOptionIdForJustification || "none (error retrieving)",
              chosen_option_output: chosenOptionFullContent,
              justification: justificationText,
              options_considered_ids: decideSpecificParams.option_operation_ids,
              criteria_used_id: decideSpecificParams.criteria_operation_id,
              model_used: llmResponse.data?.model,
              api_response_id: llmResponse.data?.id
            };

          } catch (apiError: any) {
            operationStatus = "failure";
            if (axios.isAxiosError(apiError)) {
              errorMessage = `Decide operation API error: ${apiError.response?.status} ${apiError.response?.data?.error?.message || apiError.message}`;
              operationOutput = { message: errorMessage, details: apiError.response?.data };
            } else {
              errorMessage = `Decide operation failed: ${apiError.message}`;
              operationOutput = { message: errorMessage };
            }
            console.error(errorMessage, apiError);
          }
          break;
        case "synthesize":
          try {
            const { activeConfig, actualApiKey } = await getLlmConfigAndKey();
            let synthesisContext = "Synthesizing based on the following inputs:\n";
            if (params.operation.params.input_operation_ids && params.operation.params.input_operation_ids.length > 0) {
              for (const inputOpId of params.operation.params.input_operation_ids) {
                const row = await new Promise<any>((resolve, reject) => {
                  db.get("SELECT output_data, primitive_name FROM operations WHERE operation_id = ?", [inputOpId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                  });
                });
                if (row && row.output_data) {
                  // Attempt to parse if it's JSON, otherwise use as string
                  let parsedOutput = row.output_data;
                  try {
                    parsedOutput = JSON.parse(row.output_data);
                  } catch (e) { /* not json, use as is */ }
                  synthesisContext += `\n--- Input from ${row.primitive_name} (ID: ${inputOpId}) ---\n${JSON.stringify(parsedOutput, null, 2)}\n--- End of Input --- \n`;
                } else {
                  synthesisContext += `\n--- Could not retrieve output for operation ID: ${inputOpId} ---\n`;
                }
              }
            } else {
              synthesisContext += "\n--- No specific input operations provided. Performing general synthesis. ---\n";
            }

            const synthesisGoal = params.operation.params.synthesis_goal;
            const fullPrompt = `${synthesisContext}\nSynthesis Goal: ${synthesisGoal}\nPlease provide the synthesized output. Adhere to the output format if specified: ${params.operation.params.output_format || 'natural language'}.`;
            
            const response = await axios.post(
              OPENROUTER_API_URL, // Assuming OpenRouter URL for now, or make dynamic based on activeConfig.provider
              {
                model: activeConfig.model,
                messages: [
                  { role: "system", content: "You are a helpful assistant performing a synthesis task. Combine the provided inputs to achieve the stated goal." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${actualApiKey}`,
                  "Content-Type": "application/json",
                },
              }
            );

            if (response.data && response.data.choices && response.data.choices.length > 0) {
              operationOutput = {
                synthesis_id: operationIdUUID,
                synthesized_result: response.data.choices[0].message.content,
                inputs_used: params.operation.params.input_operation_ids,
                goal_achieved: synthesisGoal,
                model_used: response.data.model,
                api_response_id: response.data.id
              };
            } else {
              operationStatus = "failure";
              errorMessage = "Synthesize operation failed: No response from LLM or unexpected format.";
              operationOutput = { message: errorMessage, details: response.data };
            }
          } catch (apiError: any) {
            operationStatus = "failure";
            if (axios.isAxiosError(apiError)) {
              errorMessage = `Synthesize operation API error: ${apiError.response?.status} ${apiError.response?.data?.error?.message || apiError.message}`;
              operationOutput = { message: errorMessage, details: apiError.response?.data };
            } else {
              errorMessage = `Synthesize operation failed: ${apiError.message}`;
              operationOutput = { message: errorMessage };
            }
            console.error(errorMessage, apiError);
          }
          break;
        case "distinguish":
          operationOutput = { distinction_id: operationIdUUID, result_type: "classification (stub)", details: `Distinguished ${params.operation.params.item_a_id} and ${params.operation.params.item_b_id}` };
          break;
        case "decide_order":
          operationOutput = { order_id: operationIdUUID, ordered_item_ids: params.operation.params.item_ids.reverse() /* stub: reverse order */ };
          break;
        case "sequence":
          operationOutput = { sequence_id: operationIdUUID, stored_item_count: params.operation.params.ordered_item_ids.length, name: params.operation.params.sequence_name || "unnamed_sequence" };
          break;
        case "compare":
          try {
            const { activeConfig, actualApiKey } = await getLlmConfigAndKey();
            const itemContents: { id: string, content: any, primitive_name?: string }[] = [];
            let allItemsFound = true;

            for (const itemId of params.operation.params.item_ids) {
              const row = await new Promise<any>((resolve, reject) => {
                db.get("SELECT output_data, primitive_name FROM operations WHERE operation_id = ?", [itemId], (err, row) => {
                  if (err) return reject(err);
                  resolve(row);
                });
              });
              if (row && row.output_data) {
                try {
                  itemContents.push({ id: itemId, content: JSON.parse(row.output_data), primitive_name: row.primitive_name });
                } catch (e) {
                  itemContents.push({ id: itemId, content: row.output_data, primitive_name: row.primitive_name }); // Store as string if not JSON
                }
              } else {
                allItemsFound = false;
                itemContents.push({ id: itemId, content: `Error: Content for item ID ${itemId} not found.` });
                console.warn(`Content for item ID ${itemId} not found during compare operation.`);
              }
            }

            if (!allItemsFound) {
              // Optionally, decide if the operation should fail or proceed with partial data
              // For now, let's proceed but note the missing items in the prompt or output.
            }

            let comparisonContext = "You are comparing the following items:\n\n";
            itemContents.forEach(item => {
              comparisonContext += `--- Item (ID: ${item.id}, Type: ${item.primitive_name || 'N/A'}) ---\n${typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2)}\n--- End of Item ---\n\n`;
            });

            const criteria = params.operation.params.criteria;
            const goal = params.operation.params.goal || "Provide a comprehensive comparison.";
            const fullPrompt = `${comparisonContext}Comparison Criteria: ${criteria}\nComparison Goal: ${goal}\n\nPlease provide the comparison result:`;

            const response = await axios.post(
              OPENROUTER_API_URL, // Assuming OpenRouter URL for now, or make dynamic based on activeConfig.provider
              {
                model: activeConfig.model,
                messages: [
                  { role: "system", content: "You are a helpful assistant that compares items based on given criteria and a goal." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${actualApiKey}`,
                  "Content-Type": "application/json",
                },
              }
            );

            if (response.data && response.data.choices && response.data.choices.length > 0) {
              operationOutput = {
                comparison_id: operationIdUUID,
                result: response.data.choices[0].message.content,
                items_compared: params.operation.params.item_ids,
                criteria_used: criteria,
                goal_stated: goal,
                model_used: response.data.model,
                api_response_id: response.data.id
              };
            } else {
              operationStatus = "failure";
              errorMessage = "Compare operation failed: No response from LLM or unexpected format.";
              operationOutput = { message: errorMessage, details: response.data };
            }
          } catch (apiError: any) {
            operationStatus = "failure";
            if (axios.isAxiosError(apiError)) {
              errorMessage = `Compare operation API error: ${apiError.response?.status} ${apiError.response?.data?.error?.message || apiError.message}`;
              operationOutput = { message: errorMessage, details: apiError.response?.data };
            } else {
              errorMessage = `Compare operation failed: ${apiError.message}`;
              operationOutput = { message: errorMessage };
            }
            console.error(errorMessage, apiError);
          }
          break;
        case "reflect":
          try {
            const { activeConfig, actualApiKey } = await getLlmConfigAndKey();
            let contextData = "";
            // Fetch output data for each target operation ID
            if (params.operation.params.target_operation_ids && params.operation.params.target_operation_ids.length > 0) {
              for (const targetId of params.operation.params.target_operation_ids) {
                const row = await new Promise<any>((resolve, reject) => {
                  db.get("SELECT output_data, primitive_name FROM operations WHERE operation_id = ?", [targetId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                  });
                });
                
                if (row && row.output_data) {
                  try {
                    const parsedOutput = JSON.parse(row.output_data);
                    contextData += `Operation (ID: ${targetId}, Type: ${row.primitive_name}): ${JSON.stringify(parsedOutput)}\n\n`;
                  } catch (e) {
                    contextData += `Operation (ID: ${targetId}, Type: ${row.primitive_name}): ${row.output_data.substring(0, 200)}...\n\n`;
                  }
                } else {
                  contextData += `Operation (ID: ${targetId}): Output not found.\n\n`;
                }
              }
            }
            
            // Build the full prompt
            const fullPrompt = `${contextData}\nReflection Prompt: ${params.operation.params.reflection_prompt}`;
            
            // Call OpenRouter API
            const response = await axios.post(
              OPENROUTER_API_URL, // Assuming OpenRouter URL for now, or make dynamic based on activeConfig.provider
              {
                model: activeConfig.model,
                messages: [
                  { role: "system", content: "You are a helpful assistant that performs reflection and meta-cognition." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${actualApiKey}`,
                  "Content-Type": "application/json",
                },
              }
            );
            
            if (response.data && response.data.choices && response.data.choices.length > 0) {
              operationOutput = {
                reflection_id: operationIdUUID,
                reflection_result: response.data.choices[0].message.content,
                targets_reflected_upon: params.operation.params.target_operation_ids,
                model_used: response.data.model,
                api_response_id: response.data.id
              };
            } else {
              operationStatus = "failure";
              errorMessage = "Reflect operation failed: No response from LLM or unexpected format.";
              operationOutput = { message: errorMessage, details: response.data };
            }
          } catch (apiError: any) {
            operationStatus = "failure";
            if (axios.isAxiosError(apiError)) {
              errorMessage = `Reflect operation API error: ${apiError.response?.status} ${apiError.response?.data?.error?.message || apiError.message}`;
              operationOutput = { message: errorMessage, details: apiError.response?.data };
            } else {
              errorMessage = `Reflect operation failed: ${apiError.message}`;
              operationOutput = { message: errorMessage };
            }
            console.error(errorMessage, apiError);
          }
          break;
        case "ask":
          try {
            const { activeConfig, actualApiKey } = await getLlmConfigAndKey();
            // Extract parameters
            const informationNeed = params.operation.params.information_need;
            const targetSource = params.operation.params.target_source || "any available source";
            const queryParams = params.operation.params.query_params ? JSON.stringify(params.operation.params.query_params) : "none";

            // Construct the prompt
            const fullPrompt = `You are an assistant that formulates queries and plans to obtain information.
Information Need: ${informationNeed}
Target Source: ${targetSource}
Additional Query Parameters: ${queryParams}

Please generate a well-formulated query, a series of questions, or a detailed plan to obtain the needed information.`;

            // Call OpenRouter API
            const response = await axios.post(
              OPENROUTER_API_URL, // Assuming OpenRouter URL for now, or make dynamic based on activeConfig.provider
              {
                model: activeConfig.model,
                messages: [
                  { role: "system", content: "You are a helpful assistant that formulates information requests." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${actualApiKey}`,
                  "Content-Type": "application/json",
                },
              }
            );

            if (response.data && response.data.choices && response.data.choices.length > 0) {
              operationOutput = {
                query_id: operationIdUUID,
                formulated_query_or_plan: response.data.choices[0].message.content,
                information_need_stated: informationNeed,
                target_source_hint: params.operation.params.target_source, // may be undefined
                model_used: response.data.model,
                api_response_id: response.data.id
              };
            } else {
              operationStatus = "failure";
              errorMessage = "Ask operation failed: No response from LLM or unexpected format.";
              operationOutput = { message: errorMessage, details: response.data };
            }
          } catch (apiError: any) {
            operationStatus = "failure";
            if (axios.isAxiosError(apiError)) {
              errorMessage = `Ask operation API error: ${apiError.response?.status} ${apiError.response?.data?.error?.message || apiError.message}`;
              operationOutput = { message: errorMessage, details: apiError.response?.data };
            } else {
              errorMessage = `Ask operation failed: ${apiError.message}`;
              operationOutput = { message: errorMessage };
            }
            console.error(errorMessage, apiError);
          }
          break;
        case "adapt":
          // Type guard for adapt operation
          if (params.operation.type !== "adapt") break;
          const opParams = params.operation.params;
          
          try {
            const { activeConfig, actualApiKey } = await getLlmConfigAndKey();
            // Fetch target operation output
            const targetRow = await new Promise<any>((resolve, reject) => {
              db.get("SELECT output_data, primitive_name FROM operations WHERE operation_id = ?", [opParams.target_operation_id], (err, row) => {
                if (err) return reject(err);
                resolve(row);
              });
            });
            
            if (!targetRow || !targetRow.output_data) {
              operationStatus = "failure";
              errorMessage = `Target operation ID ${opParams.target_operation_id} not found or has no output data.`;
              operationOutput = { message: errorMessage };
              console.error(errorMessage);
              break;
            }
            
            // Parse or truncate target content
            let targetContent = targetRow.output_data;
            try {
              const parsed = JSON.parse(targetContent);
              targetContent = JSON.stringify(parsed, null, 2);
            } catch (e) {
              targetContent = targetContent.substring(0, 2000);
            }
            
            // Fetch feedback if provided
            let feedbackContent = "";
            if (opParams.feedback_id) {
              const feedbackRow = await new Promise<any>((resolve, reject) => {
                db.get("SELECT output_data FROM operations WHERE operation_id = ?", [opParams.feedback_id], (err, row) => {
                  if (err) return reject(err);
                  resolve(row);
                });
              });
              
              if (feedbackRow && feedbackRow.output_data) {
                try {
                  const parsedFeedback = JSON.parse(feedbackRow.output_data);
                  feedbackContent = `Feedback (ID: ${opParams.feedback_id}):\n${JSON.stringify(parsedFeedback, null, 2)}\n\n`;
                } catch (e) {
                  feedbackContent = `Feedback (ID: ${opParams.feedback_id}):\n${feedbackRow.output_data.substring(0, 1000)}...\n\n`;
                }
              }
            }
            
            // Build the prompt
            const fullPrompt = `${feedbackContent}Original Content (ID: ${opParams.target_operation_id}):\n${targetContent}\n\nAdaptation Instruction: ${opParams.adaptation_instruction}\n\nPlease provide the adapted version:`;
            
            // Call OpenRouter API
            const response = await axios.post(
              OPENROUTER_API_URL, // Assuming OpenRouter URL for now, or make dynamic based on activeConfig.provider
              {
                model: activeConfig.model,
                messages: [
                  { role: "system", content: "You are a helpful assistant that adapts content based on instructions and feedback." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${actualApiKey}`,
                  "Content-Type": "application/json",
                },
              }
            );
            
            if (response.data && response.data.choices && response.data.choices.length > 0) {
              operationOutput = {
                adaptation_id: operationIdUUID,
                adapted_content_or_suggestion: response.data.choices[0].message.content,
                original_target_id: opParams.target_operation_id,
                feedback_used_id: opParams.feedback_id || null,
                model_used: response.data.model,
                api_response_id: response.data.id
              };
            } else {
              operationStatus = "failure";
              errorMessage = "Adapt operation failed: No response from LLM or unexpected format.";
              operationOutput = { message: errorMessage, details: response.data };
            }
          } catch (apiError: any) {
            operationStatus = "failure";
            if (axios.isAxiosError(apiError)) {
              errorMessage = `Adapt operation API error: ${apiError.response?.status} ${apiError.response?.data?.error?.message || apiError.message}`;
              operationOutput = { message: errorMessage, details: apiError.response?.data };
            } else {
              errorMessage = `Adapt operation failed: ${apiError.message}`;
              operationOutput = { message: errorMessage };
            }
            console.error(errorMessage, apiError);
          }
          break;
        case "retrieve_artifact":
          try {
            const artifactIdToRetrieve = params.operation.params.artifact_id;
            const row = await new Promise<any>((resolve, reject) => {
              db.get("SELECT output_data FROM operations WHERE operation_id = ?", [artifactIdToRetrieve], (err, row) => {
                if (err) {
                  console.error(`Error retrieving artifact ${artifactIdToRetrieve}:`, err);
                  return reject(err);
                }
                resolve(row);
              });
            });

            if (row && row.output_data) {
              let parsedArtifactData;
              try {
                parsedArtifactData = JSON.parse(row.output_data);
                operationOutput = {
                  artifact_id: artifactIdToRetrieve,
                  artifact_data: parsedArtifactData,
                  metadata: { version: params.operation.params.version || "latest" }
                };
              } catch (parseError: any) {
                operationStatus = "failure";
                errorMessage = `Artifact with ID ${artifactIdToRetrieve} has non-JSON output_data: ${parseError.message}. Output preview: ${String(row.output_data).substring(0,100)}`;
                operationOutput = { message: errorMessage, artifact_id: artifactIdToRetrieve };
                console.error(errorMessage);
              }
            } else {
              operationStatus = "failure";
              errorMessage = `Artifact with ID ${artifactIdToRetrieve} not found.`;
              operationOutput = { message: errorMessage, artifact_id: artifactIdToRetrieve };
            }
          } catch (dbError: any) {
            operationStatus = "failure";
            errorMessage = `Database error retrieving artifact ${params.operation.params.artifact_id}: ${dbError.message}`;
            operationOutput = { message: errorMessage, artifact_id: params.operation.params.artifact_id };
            console.error(errorMessage, dbError);
          }
          break;
        case "retrieve_observation":
          operationOutput = { observation_id: params.operation.params.observation_id, observed_data: "Retrieved observation data (stub)", metadata: {} };
          break;
        default:
          operationStatus = "failure";
          errorMessage = `Error: Unknown operation type.`;
          operationOutput = { message: errorMessage };
      }
    } catch (e: any) {
        operationStatus = "failure";
        errorMessage = e.message || "An unexpected error occurred during operation processing.";
        operationOutput = { message: errorMessage };
        // Log to console as well for server-side visibility
        console.error(`Error processing operation ${operationIdUUID} for chain ${currentChainId}:`, e);
    }

    const endTime = new Date().toISOString();
    const inputDataString = JSON.stringify(params.operation.params);
    const outputDataString = JSON.stringify(operationOutput);
    
    const hash = crypto.createHash('sha256')
      .update(operationIdUUID)
      .update(params.operation.type)
      .update(inputDataString)
      .update(outputDataString)
      .update(operationStatus)
      .digest('hex');

    // 3. Insert operation into DB
    const operationName = params.operation_name || `${params.operation.type.charAt(0).toUpperCase() + params.operation.type.slice(1)} Operation No. ${operationIdUUID.substring(0, 4)}`;

    const dbOperationInternalId = await new Promise<number>((resolve, reject) => {
      db.run(
        `INSERT INTO operations (operation_id, operation_name, primitive_name, input_data, output_data, status, start_time, end_time, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, json_object('chain_id', ?, 'branch_id', ?, 'parent_operation_uuid', ?, 'hash', ?))`,
        [
          operationIdUUID,
          operationName, // Added operation_name
          params.operation.type,
          inputDataString,
          outputDataString,
          operationStatus,
          startTime,
          endTime,
          currentChainId,
          params.branch_id,
          params.parent_operation_id,
          hash
        ],
        function (this: sqlite3.RunResult, err) {
          if (err) {
            console.error("Error inserting operation:", err);
            return reject(err);
          }
          resolve(this.lastID); // This is the auto-incremented 'id' (PK)
        }
      );
    });

    // 4. Insert relationship if parent_operation_id is provided
    if (params.parent_operation_id) {
      const parentDbId = await new Promise<number | undefined>((resolve, reject) => {
        db.get("SELECT id FROM operations WHERE operation_id = ?", [params.parent_operation_id], (err, parentRow: any) => {
          if (err) {
            console.error("Error fetching parent operation DB ID:", err);
            return reject(err);
          }
          resolve(parentRow ? parentRow.id : undefined);
        });
      });

      if (parentDbId && dbOperationInternalId) {
        await new Promise<void>((resolve, reject) => {
          db.run(
            "INSERT INTO operation_relationships (parent_id, child_id, relationship_type, sequence_order) VALUES (?, ?, ?, ?)",
            [parentDbId, dbOperationInternalId, params.branch_id ? "branch" : "sequential", null], // sequence_order can be enhanced later
            (relErr) => {
              if (relErr) {
                console.error("Error inserting operation relationship:", relErr);
                return reject(relErr);
              }
              resolve();
            }
          );
        });
      } else if (dbOperationInternalId) { // Parent UUID provided but not found
        console.warn(`Parent operation UUID ${params.parent_operation_id} not found in DB for relationship. Operation ${operationIdUUID} will not be linked.`);
      }
    } else if (isNewChain && dbOperationInternalId) {
        // If no parent and it's a new chain, this is the root operation.
        await new Promise<void>((resolve, reject) => {
            db.run("UPDATE logic_chains SET root_operation = ? WHERE chain_id = ?",
            [dbOperationInternalId, currentChainId],
            (updateErr) => {
                if(updateErr) {
                    console.error("Error updating chain's root operation:", updateErr);
                    return reject(updateErr);
                }
                resolve();
            });
        });
    }
    
    // Note: logic_chains.last_updated_at is not in the schema, so not updating it.

    return {
      content: [
        {
          type: "text", // Changed from "json" to "text"
          text: JSON.stringify({ // Stringify the JSON payload
            chain_id: currentChainId,
            chain_name: finalChainName, // Include chain_name
            operation_id: operationIdUUID,
            operation_name: operationName, // Include operation_name
            operation_type: params.operation.type,
            status: operationStatus,
            output: operationOutput,
            error_message: errorMessage,
          }, null, 2), // Pretty-print JSON for readability
        },
      ],
      isError: operationStatus === "failure",
    };
  }
);

async function main() {
console.log("<<<<< SERVER MAIN FUNCTION STARTED - VERSION WITH EXTENSIVE LOGGING >>>>>"); // New prominent log
  try {
    await initializeDatabase();

    // Start HTTP server for API
    app.listen(HTTP_PORT, () => {
      console.log(`HTTP API server listening on port ${HTTP_PORT}`);
    });

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log(`Logic MCP server "logic-mcp" running on stdio, using database at ${DB_PATH}`);
  } catch (error) {
    console.error("Failed to initialize or start Logic MCP server:", error);
    process.exit(1);
  }
}

main().catch(error => { // This catch might be redundant now due to try/catch in main
  console.error("Failed to start Logic MCP server:", error);
  process.exit(1);
});