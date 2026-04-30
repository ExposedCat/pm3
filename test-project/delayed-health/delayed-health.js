const fs = require("node:fs");
const http = require("node:http");

const port = 3000;
const readyDelayMs = 5000;

fs.writeFileSync("/tmp/pm3-ready-at", String(Date.now() + readyDelayMs));

http
  .createServer((_request, response) => {
    response.end("delayed-health service\n");
  })
  .listen(port, () => {
    console.log(`delayed-health service listening on ${port}`);
  });
