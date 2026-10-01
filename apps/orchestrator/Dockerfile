FROM golang:1.25.7-alpine3.23 AS development
WORKDIR /src
COPY apps/orchestrator/go.mod ./
COPY apps/orchestrator/cmd ./cmd
EXPOSE 8080
# Rebuild on restart; the development source bind is read-only.
CMD ["sh", "-c", "go build -o /tmp/orchestrator ./cmd/server && exec /tmp/orchestrator"]

FROM development AS builder
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/orchestrator ./cmd/server

FROM alpine:3.23.3 AS production
RUN addgroup -S app && adduser -S -G app app
COPY --from=builder /out/orchestrator /usr/local/bin/orchestrator
USER app
EXPOSE 8080
CMD ["orchestrator"]
