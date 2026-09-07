.PHONY: install build check test verify
install:
	npm ci
build:
	npm run build
check:
	npm run test:contract
test:
	npm run test
verify:
	npm run verify
