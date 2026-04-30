const http = require("node:http");

const port = 3000;

http
  .createServer((_request, response) => {
    response.end("delayed-health service\n");
  })
  .listen(port, () => {
    console.log(`delayed-health service listening on ${port}`);
  });
