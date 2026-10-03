# Build stage
FROM golang:1.25-alpine AS builder

WORKDIR /app
COPY apps/recorder/go.mod apps/recorder/go.sum ./
RUN go mod download

COPY apps/recorder/ .
RUN CGO_ENABLED=0 go build -o /recorder ./cmd

# Runtime stage
FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=builder /recorder /recorder

EXPOSE 8081 8082

CMD ["/recorder"]
