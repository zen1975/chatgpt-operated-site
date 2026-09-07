.PHONY: check lock bootstrap verify build test manifest
check:
	npm run bootstrap:check
lock:
	./scripts/lock-dependencies.sh
bootstrap:
	npm run bootstrap:local
verify:
	npm run verify
build:
	npm run build
test:
	npm run test:command
manifest:
	npm run manifest
