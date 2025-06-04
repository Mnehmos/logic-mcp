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
const DB_PATH = path.join(process.cwd(), DB_FILE_NAME); // Assumes server runs from its root