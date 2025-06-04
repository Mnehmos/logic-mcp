# Logic MCP Server

## Overview

The `logic-mcp` server is a backend application designed to execute advanced logic primitives and cognitive operations. It leverages the Model Context Protocol (MCP) to provide tools for reasoning, data processing, and interaction with Large Language Models (LLMs). This server forms the core engine for complex task execution and structured thought processing.

It features dynamic LLM configuration, allowing users to switch between different language models and providers (like OpenRouter, Google Gemini, etc.) via API calls or a companion web application. All operations and their relationships are traced and stored in a SQLite database, enabling history reconstruction and logic chain visualization.

This server is intended to be used in conjunction with the [Logic MCP Webapp](https://github.com/Mnehmos/logic-mcp-webapp) for easier management and interaction.

## Demonstration: Logic Puzzle Solving

Watch a demonstration of the Logic MCP server attempting to solve the "Passport Pandemonium" logic puzzle:

[![Logic MCP Solves Passport Pandemonium](https://img.youtube.com/vi/lFt_XrPvSIA/0.jpg)](https://www.youtube.com/watch?v=lFt_XrPvSIA) 

## Features

-   **Model Context Protocol (MCP) Server**: Exposes logic operations as tools.
-   **Dynamic LLM Configuration**:
    -   Add, activate, and delete LLM provider configurations (e.g., OpenRouter, Gemini).
    -   Server uses the currently active LLM configuration.
    -   Falls back to a default LLM if no user configuration is active.
-   **Logic Primitives**: Supports operations like `define`, `infer`, `decide`, `synthesize`, etc. (extensible).
-   **Database Tracing**: All operations and logic chains are stored in a SQLite database for traceability and history.
-   **HTTP API**:
    -   Manage LLM configurations (`/api/llm-config`).
    -   Explore logic chains and operations (`/api/logic-explorer`).
-   **Environment Variable Management**: Uses a `.env` file for API keys.

## Companion Web Application

A web application is available to interact with this server, manage LLM configurations, and explore logic chains:
-   **Repository**: [Mnehmos/logic-mcp-webapp](https://github.com/Mnehmos/logic-mcp-webapp)
-   **Functionality**:
    -   View and manage LLM provider configurations.
    -   Activate specific LLM configurations for the server to use.
    -   View executed logic chains and their operations.
    -   Clear LLM configurations and logic chain history.

## Getting Started

### Prerequisites

-   Node.js (version recommended by your project, e.g., v18+)
-   npm or yarn

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/Mnehmos/logic-mcp.git
    cd logic-mcp
    ```
2.  Install dependencies:
    ```bash
    npm install
    # or
    # yarn install
    ```
3.  Set up environment variables:
    -   Copy `.env.example` to `.env` (if an example file exists, otherwise create `.env`).
    -   Fill in the required API keys, especially `OPENROUTER_API_KEY` for the default LLM and any other providers you intend to use (e.g., `GEMINI_API_KEY`).
    ```env
    OPENROUTER_API_KEY="your_openrouter_key"
    GEMINI_API_KEY="your_gemini_key"
    # ... other keys ...
    HTTP_PORT=3001 # Port for the HTTP API
    ```

### Running the Server

1.  Compile TypeScript:
    ```bash
    npm run build
    # or
    # tsc
    ```
2.  Start the server:
    ```bash
    npm start
    # or
    # node build/index.js
    ```

The MCP server will start on stdio, and the HTTP API will be available (default: `http://localhost:3001`).

## API Endpoints

-   **LLM Configurations**: `GET, POST, PUT, DELETE /api/llm-config`
    -   Activate: `PATCH /api/llm-config/:id/activate`
-   **Logic Explorer**: `GET /api/logic-explorer/chains`, `GET /api/logic-explorer/chains/:chainId`, etc.

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.

---

*This README provides a basic overview. Further details on specific primitives, API usage, and advanced configurations will be added as the project evolves.*