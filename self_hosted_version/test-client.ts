import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  console.log('Connected to MTProto server');
  
  // Send first byte 0xef to initiate abridged mode
  ws.send(Buffer.from([0xef]));
});

ws.on('message', (data: Buffer) => {
  console.log('Received:', data.toString('hex').slice(0, 80) + '...');
  console.log('Length:', data.length);
  
  // After abridged handshake, server should send back the tag
  if (data[0] === 0xef) {
    console.log('Abridged mode acknowledged');
  }
});

ws.on('close', () => {
  console.log('Disconnected');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('Test timeout');
  ws.close();
  process.exit(0);
}, 5000);
