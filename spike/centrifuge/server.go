package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/centrifugal/centrifuge"
)

const (
	listenAddress = "127.0.0.1:18000"
	channel       = "looprig:spike"
	serverVersion = "github.com/centrifugal/centrifuge@v0.38.0"
	wireVersion   = 1
)

type connectData struct {
	WireVersion int `json:"wire_version"`
}

type connectionRegistry struct {
	mu      sync.Mutex
	client  *centrifuge.Client
	missOne atomic.Bool
}

func (r *connectionRegistry) set(client *centrifuge.Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.client = client
}

func (r *connectionRegistry) current() *centrifuge.Client {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.client
}

func main() {
	logger := log.New(log.Writer(), "server ", 0)
	node, err := centrifuge.New(centrifuge.Config{
		HistoryMetaTTL: time.Minute,
	})
	if err != nil {
		logger.Fatal(err)
	}

	registry := &connectionRegistry{}
	node.OnConnecting(func(_ context.Context, event centrifuge.ConnectEvent) (centrifuge.ConnectReply, error) {
		var data connectData
		if err := json.Unmarshal(event.Data, &data); err != nil {
			logger.Printf("connect rejected name=%s sdk=%s reason=bad_data", event.Name, event.Version)
			return centrifuge.ConnectReply{}, centrifuge.Disconnect{Code: 4500, Reason: "unsupported wire version"}
		}
		logger.Printf("connect name=%s sdk=%s transport=%s protocol=%s wire=%d", event.Name, event.Version, event.Transport.Name(), event.Transport.Protocol(), data.WireVersion)
		if data.WireVersion != wireVersion {
			return centrifuge.ConnectReply{}, centrifuge.Disconnect{Code: 4500, Reason: "unsupported wire version"}
		}
		replyData, err := json.Marshal(map[string]any{
			"client_name":    event.Name,
			"client_version": event.Version,
			"server":         serverVersion,
			"wire_version":   wireVersion,
		})
		if err != nil {
			return centrifuge.ConnectReply{}, err
		}
		return centrifuge.ConnectReply{
			Credentials: &centrifuge.Credentials{UserID: "spike-user"},
			Data:        replyData,
		}, nil
	})

	node.OnConnect(func(client *centrifuge.Client) {
		registry.set(client)
		client.OnSubscribe(func(event centrifuge.SubscribeEvent, callback centrifuge.SubscribeCallback) {
			if event.Channel != channel {
				logger.Printf("subscribe denied channel=%s", event.Channel)
				callback(centrifuge.SubscribeReply{}, centrifuge.ErrorPermissionDenied)
				return
			}
			logger.Printf("subscribe allowed channel=%s recoverable=%t positioned=%t", event.Channel, event.Recoverable, event.Positioned)
			callback(centrifuge.SubscribeReply{Options: centrifuge.SubscribeOptions{
				EnableRecovery:    true,
				EnablePositioning: true,
			}}, nil)
		})
		client.OnRPC(func(event centrifuge.RPCEvent, callback centrifuge.RPCCallback) {
			logger.Printf("rpc method=%s", event.Method)
			if event.Method != "echo" {
				callback(centrifuge.RPCReply{}, centrifuge.ErrorMethodNotFound)
				return
			}
			callback(centrifuge.RPCReply{Data: event.Data}, nil)
		})
		client.OnDisconnect(func(event centrifuge.DisconnectEvent) {
			logger.Printf("disconnect code=%d reason=%s", event.Code, event.Reason)
			if registry.missOne.CompareAndSwap(true, false) {
				publish(node, logger, "missed-during-reconnect")
			}
		})
	})

	if err := node.Run(); err != nil {
		logger.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("/connection/websocket", centrifuge.NewWebsocketHandler(node, centrifuge.WebsocketConfig{
		CheckOrigin: func(*http.Request) bool { return true },
	}))
	mux.HandleFunc("GET /health", func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /control/publish", func(writer http.ResponseWriter, _ *http.Request) {
		publish(node, logger, "live")
		writer.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /control/reconnect", func(writer http.ResponseWriter, _ *http.Request) {
		client := registry.current()
		if client == nil {
			http.Error(writer, "no client", http.StatusConflict)
			return
		}
		registry.missOne.Store(true)
		logger.Printf("forcing reconnect code=%d", centrifuge.DisconnectForceReconnect.Code)
		client.Disconnect(centrifuge.DisconnectForceReconnect)
		writer.WriteHeader(http.StatusNoContent)
	})

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           mux,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	logger.Printf("ready address=%s server=%s", listenAddress, serverVersion)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		logger.Fatal(err)
	}
}

func publish(node *centrifuge.Node, logger *log.Logger, kind string) {
	data, err := json.Marshal(map[string]string{"kind": kind})
	if err != nil {
		logger.Printf("publish marshal error=%v", err)
		return
	}
	result, err := node.Publish(channel, data, centrifuge.WithHistory(100, time.Minute))
	if err != nil {
		logger.Printf("publish error=%v", err)
		return
	}
	logger.Printf("publish channel=%s kind=%s offset=%d epoch=%s", channel, kind, result.Offset, result.Epoch)
}
