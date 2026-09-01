# Centrifuge compatibility spike harness

This disposable harness runs the official JavaScript clients `centrifuge@5.7.2`
and `centrifuge@5.6.0` against a real embedded
`github.com/centrifugal/centrifuge@v0.38.0` WebSocket server.

```sh
GOWORK=off go mod download
npm ci --ignore-scripts
GOWORK=off go run . >server.log 2>&1 &
curl --retry 30 --retry-connrefused --retry-delay 0 \
  http://127.0.0.1:18000/health
npm run test:5.7.2
npm run test:5.6.0
```

Stop the background server after both runs. The server binds only to loopback.
