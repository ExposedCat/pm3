const http = require("node:http");

const port = 3000;

http.createServer((_request, response) => {
  response.end("prebuilt service\n");
}).listen(port, () => {
  console.log(`prebuilt service listening on ${port}`);
});
