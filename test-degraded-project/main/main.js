const http = require("node:http");

const port = 3000;

http.createServer((_request, response) => {
  response.end("main service\n");
}).listen(port, () => {
  console.log(`main service listening on ${port}`);
});
