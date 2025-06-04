// Test script to make a DELETE request to /api/llm-config/all
// Save this as test-delete-all-request.js and run with: node test-delete-all-request.js

const http = require('http');

function makeDeleteAllRequest(port, path) {
  const options = {
    hostname: 'localhost',
    port: port,
    path: path,
    method: 'DELETE',
    headers: {
      // 'Content-Type': 'application/json', // Not strictly needed for DELETE with no body
      'Origin': 'http://localhost' // Simulate browser origin
      // If MCP_SERVER_API_KEY_FOR_WEBAPP were active, we'd add:
      // 'Authorization': 'Bearer YOUR_MCP_SERVER_API_KEY_FOR_WEBAPP_VALUE' 
    }
  };

  console.log(`\n=== Making DELETE request to http://localhost:${port}${path} ===`);
  console.log('Request Options:', JSON.stringify(options, null, 2));

  const req = http.request(options, (res) => {
    console.log(`\nStatus Code: ${res.statusCode}`);
    console.log('Response Headers:', JSON.stringify(res.headers, null, 2));

    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      console.log('Response Body:', data);
      if (data) {
        try {
          const jsonData = JSON.parse(data);
          console.log('Parsed Response Body:', JSON.stringify(jsonData, null, 2));
        } catch (e) {
          console.log('Response body is not valid JSON.');
        }
      }
    });
  });

  req.on('error', (e) => {
    console.error(`Request error: ${e.message}`);
  });

  req.end(); // End the request (no body for this DELETE)
}

// Test against the main server
console.log('Testing DELETE /api/llm-config/all against main server (port 3001)...');
makeDeleteAllRequest(3001, '/api/llm-config/all');