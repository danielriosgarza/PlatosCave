// Package fixture holds the connector's tests against real sshd and real Jupyter (docs/design/
// connector.md §15). They run only with the build tag `fixture`, after
// `scripts/connector-fixture-keys.sh` and `docker compose -f infra/compose.yml --profile connector
// up -d --wait`: `go test -tags fixture ./internal/fixture/`.
package fixture
