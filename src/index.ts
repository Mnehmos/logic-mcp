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

// Load environment variables from .env file
dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const DB_FILE_NAME = 'logic_mcp.db';
const DB_PATH = path.join(process.cwd(), DB_FILE_NAME); // Assumes server runs from its root dir

let db: sqlite3.Database;

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
    description TEXT,                   -- Human-readable description
    root_operation INTEGER,             -- Starting operation ID
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (root_operation) REFERENCES operations(id)
);

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_operations_primitive ON operations(primitive_name);
CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_relationships_parent ON operation_relationships(parent_id);
CREATE INDEX IF NOT EXISTS idx_relationships_child ON operation_relationships(child_id);
      `;

      db.exec(schema, (execErr) => {
        if (execErr) {
          console.error('Error executing schema', execErr.message);
          return reject(execErr);
        }
        console.log('Database schema applied successfully.');
        resolve();
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

// --- Tool Input Schema ---
const executeLogicOperationInputSchema = z.object({
  chain_id: z.string().uuid().optional().describe("ID of the logic chain. If not provided, a new chain is created and its ID returned."),
  parent_operation_id: z.string().uuid().optional().describe("ID of the parent operation in this chain, for explicit sequencing. Helps build the execution graph."),
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
    let operationOutput: any = { message: "Operation processed (stub)." };
    let operationStatus: "success" | "failure" = "success";
    let errorMessage: string | undefined;
    let currentChainId = params.chain_id;
    let isNewChain = false;

    try {
      // 1. Ensure chain exists or create it
      if (!currentChainId) {
        isNewChain = true;
        currentChainId = randomUUID();
        await new Promise<void>((resolve, reject) => {
          db.run(
            "INSERT INTO logic_chains (chain_id, description, created_at) VALUES (?, ?, ?)",
            [currentChainId, `Chain started with ${params.operation.type} operation`, startTime],
            (err) => {
              if (err) {
                console.error("Error creating new chain:", err);
                return reject(err);
              }
              resolve();
            }
          );
        });
      } else {
        // Verify chain exists
        const chainRow = await new Promise((resolve, reject) => {
          db.get("SELECT chain_id FROM logic_chains WHERE chain_id = ?", [currentChainId], (err, row) => {
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
      }

      // 2. Basic dispatch logic (stubbed implementations)
      // The operationIdUUID is used in the output for consistency if needed by client
      switch (params.operation.type) {
        case "observe":
          operationOutput = { observation_id: operationIdUUID, data_summary: `Observed: ${params.operation.params.source_description}`, raw_data_preview: params.operation.params.raw_data ? String(params.operation.params.raw_data).substring(0,100) : "N/A" };
          break;
        case "define":
          if (!OPENROUTER_API_KEY) {
            operationStatus = "failure";
            errorMessage = "OpenRouter API key is not configured in .env file for define operation.";
            operationOutput = { message: errorMessage };
            console.error(errorMessage);
            break;
          }
          try {
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
            
            // Call OpenRouter API
            const response = await axios.post(
              OPENROUTER_API_URL,
              {
                model: "deepseek/deepseek-r1-0528:free",
                messages: [
                  { role: "system", content: "You are a helpful assistant that provides clear, concise definitions of concepts." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                  "Content-Type": "application/json",
                },
              }
            );
            
            if (response.data && response.data.choices && response.data.choices.length > 0) {
              operationOutput = {
                definition_id: operationIdUUID,
                concept_defined: conceptName,
                generated_definition: response.data.choices[0].message.content,
                based_on_observations: params.operation.params.based_on_observation_ids || [],
                model_used: response.data.model,
                api_response_id: response.data.id
              };
            } else {
              operationStatus = "failure";
              errorMessage = "Define operation failed: No response from LLM or unexpected format.";
              operationOutput = { message: errorMessage, details: response.data };
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
          if (!OPENROUTER_API_KEY) {
            operationStatus = "failure";
            errorMessage = "OpenRouter API key is not configured in .env file.";
            operationOutput = { message: errorMessage };
            console.error(errorMessage);
            break;
          }
          try {
            // Simplified premise handling: For now, just acknowledge them.
            // A full implementation would fetch and summarize content from these premise operations.
            let premiseContext = "";
            if (params.operation.params.premise_operation_ids && params.operation.params.premise_operation_ids.length > 0) {
                premiseContext = `Based on previous operations (IDs: ${params.operation.params.premise_operation_ids.join(', ')}), `;
            }

            const userPrompt = params.operation.params.prompt_or_query || "Perform a general inference.";
            const fullPrompt = premiseContext + userPrompt;

            const response = await axios.post(
              OPENROUTER_API_URL,
              {
                model: "deepseek/deepseek-r1-0528:free", // Specify the model
                messages: [
                  { role: "system", content: "You are a helpful assistant performing a logical inference." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                  "Content-Type": "application/json",
                  // Recommended by OpenRouter:
                  // "HTTP-Referer": `${YOUR_SITE_URL}`,
                  // "X-Title": `${YOUR_SITE_NAME}`,
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
          if (!OPENROUTER_API_KEY) {
            operationStatus = "failure";
            errorMessage = "OpenRouter API key is not configured in .env file for decide operation.";
            operationOutput = { message: errorMessage };
            console.error(errorMessage);
            break;
          }
          try {
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
              OPENROUTER_API_URL,
              {
                model: "deepseek/deepseek-r1-0528:free",
                messages: [
                  { role: "system", content: "You are a helpful assistant that provides justifications for decisions based on options and criteria." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
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
          if (!OPENROUTER_API_KEY) {
            operationStatus = "failure";
            errorMessage = "OpenRouter API key is not configured in .env file for synthesize operation.";
            operationOutput = { message: errorMessage };
            console.error(errorMessage);
            break;
          }
          try {
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
              OPENROUTER_API_URL,
              {
                model: "deepseek/deepseek-r1-0528:free",
                messages: [
                  { role: "system", content: "You are a helpful assistant performing a synthesis task. Combine the provided inputs to achieve the stated goal." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
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
          if (!OPENROUTER_API_KEY) {
            operationStatus = "failure";
            errorMessage = "OpenRouter API key is not configured in .env file for compare operation.";
            operationOutput = { message: errorMessage };
            console.error(errorMessage);
            break;
          }
          try {
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
              OPENROUTER_API_URL,
              {
                model: "deepseek/deepseek-r1-0528:free",
                messages: [
                  { role: "system", content: "You are a helpful assistant that compares items based on given criteria and a goal." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
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
          if (!OPENROUTER_API_KEY) {
            operationStatus = "failure";
            errorMessage = "OpenRouter API key is not configured in .env file for reflect operation.";
            operationOutput = { message: errorMessage };
            console.error(errorMessage);
            break;
          }
          try {
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
              OPENROUTER_API_URL,
              {
                model: "deepseek/deepseek-r1-0528:free",
                messages: [
                  { role: "system", content: "You are a helpful assistant that performs reflection and meta-cognition." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
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
          if (!OPENROUTER_API_KEY) {
            operationStatus = "failure";
            errorMessage = "OpenRouter API key is not configured in .env file for ask operation.";
            operationOutput = { message: errorMessage };
            console.error(errorMessage);
            break;
          }
          try {
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
              OPENROUTER_API_URL,
              {
                model: "deepseek/deepseek-r1-0528:free",
                messages: [
                  { role: "system", content: "You are a helpful assistant that formulates information requests." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
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
          
          if (!OPENROUTER_API_KEY) {
            operationStatus = "failure";
            errorMessage = "OpenRouter API key is not configured in .env file for adapt operation.";
            operationOutput = { message: errorMessage };
            console.error(errorMessage);
            break;
          }
          try {
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
              OPENROUTER_API_URL,
              {
                model: "deepseek/deepseek-r1-0528:free",
                messages: [
                  { role: "system", content: "You are a helpful assistant that adapts content based on instructions and feedback." },
                  { role: "user", content: fullPrompt }
                ],
              },
              {
                headers: {
                  "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
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
    const dbOperationInternalId = await new Promise<number>((resolve, reject) => {
      db.run(
        `INSERT INTO operations (operation_id, primitive_name, input_data, output_data, status, start_time, end_time, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, json_object('chain_id', ?, 'branch_id', ?, 'parent_operation_uuid', ?, 'hash', ?))`,
        [
          operationIdUUID,
          params.operation.type,
          inputDataString,
          outputDataString,
          operationStatus,
          startTime,
          endTime,
          currentChainId, // Store chain_id in context as well for easier querying if needed
          params.branch_id,
          params.parent_operation_id, // Store the UUID of the parent
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
            operation_id: operationIdUUID,
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
  try {
    await initializeDatabase();
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