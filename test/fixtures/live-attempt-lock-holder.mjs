import { createServer } from 'node:net';

const port = Number(process.argv[2]);
const host = process.argv[3];
if (!Number.isInteger(port) || !host) throw new Error('lock endpoint is required');

const server = createServer(socket => socket.destroy());
server.listen({ host, port, exclusive: true }, () => {
  process.stdout.write('ready\n');
});
