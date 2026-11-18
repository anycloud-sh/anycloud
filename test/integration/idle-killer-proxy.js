/**
 * TCP Proxy that kills idle connections
 * Simulates AWS NAT Gateway killing connections idle for 350+ seconds
 * This version uses 10 seconds for fast testing
 */

import net from 'net';

const PROXY_PORT = parseInt(process.argv[2] || '2223');
const TARGET_PORT = parseInt(process.argv[3] || '22');
const IDLE_TIMEOUT_MS = parseInt(process.argv[4] || '10000'); // 10 seconds

console.log(`[Proxy] Starting idle-killer proxy:`);
console.log(`  Listen: 0.0.0.0:${PROXY_PORT}`);
console.log(`  Target: 127.0.0.1:${TARGET_PORT}`);
console.log(`  Idle timeout: ${IDLE_TIMEOUT_MS}ms`);

const server = net.createServer((clientSocket) => {
  console.log(
    `[Proxy] New connection from ${clientSocket.remoteAddress}:${clientSocket.remotePort}`,
  );

  // Connect to SSH server
  const targetSocket = net.createConnection({
    host: '127.0.0.1',
    port: TARGET_PORT,
  });

  let lastActivity = Date.now();
  let connectionKilled = false;

  // Update activity timestamp whenever data flows
  const updateActivity = () => {
    lastActivity = Date.now();
  };

  // Check for idle timeout every second
  const idleChecker = setInterval(() => {
    const idleTime = Date.now() - lastActivity;
    if (idleTime > IDLE_TIMEOUT_MS && !connectionKilled) {
      connectionKilled = true;
      console.log(
        `[Proxy] Connection idle for ${idleTime}ms - KILLING (simulates AWS NAT timeout)`,
      );

      // Destroy both ends of connection (simulates NAT gateway RST)
      clientSocket.destroy();
      targetSocket.destroy();
      clearInterval(idleChecker);
    }
  }, 1000);

  // Forward data: client -> target
  clientSocket.on('data', (data) => {
    updateActivity();
    if (!connectionKilled) {
      targetSocket.write(data);
    }
  });

  // Forward data: target -> client
  targetSocket.on('data', (data) => {
    updateActivity();
    if (!connectionKilled) {
      clientSocket.write(data);
    }
  });

  // Handle errors and cleanup
  const cleanup = (reason) => {
    if (!connectionKilled) {
      console.log(`[Proxy] Connection closed: ${reason}`);
    }
    clearInterval(idleChecker);
    clientSocket.destroy();
    targetSocket.destroy();
  };

  clientSocket.on('error', (err) => cleanup(`client error: ${err.message}`));
  targetSocket.on('error', (err) => cleanup(`target error: ${err.message}`));
  clientSocket.on('end', () => cleanup('client closed'));
  targetSocket.on('end', () => cleanup('target closed'));
});

server.listen(PROXY_PORT, () => {
  console.log(`[Proxy] Listening on port ${PROXY_PORT}`);
});

server.on('error', (err) => {
  console.error(`[Proxy] Server error: ${err.message}`);
  process.exit(1);
});
