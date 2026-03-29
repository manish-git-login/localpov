#!/usr/bin/env node

// MCP server entry point — used by AI coding agents
// Configure in .claude/settings.json, .cursor/mcp.json, etc:
//
//   {
//     "mcpServers": {
//       "localpov": {
//         "command": "npx",
//         "args": ["localpov", "--mcp"]
//       }
//     }
//   }

require('../dist/mcp-server');
