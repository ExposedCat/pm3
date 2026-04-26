const http = require("node:http");

const port = 3000;

http.createServer((_request, response) => {
  response.end("built service\n");
}).listen(port, () => {
  console.log(`built service listening on ${port}`);
});
