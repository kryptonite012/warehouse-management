FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/quickstore-edge ./cmd/quickstore-edge

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/quickstore-edge /quickstore-edge
VOLUME ["/data"]
ENV EDGE_DATA_DIR=/data EDGE_LISTEN=:8090
EXPOSE 8090
ENTRYPOINT ["/quickstore-edge"]
