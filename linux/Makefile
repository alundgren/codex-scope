CC ?= cc
CFLAGS ?= -O2 -std=c11 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=3 -fstack-protector-strong

.PHONY: all test benchmark load-check probe service-check clean
all: build/observer

build/observer: observer.c
	mkdir -p build
	$(CC) $(CFLAGS) $< -o $@

test: all
	python3 -m unittest discover -s tests -v

benchmark: all
	python3 scripts/benchmark.py

load-check: all
	python3 scripts/load_check.py

probe: all
	python3 scripts/probe_codex.py

service-check: all
	python3 scripts/check_service.py

clean:
	rm -rf build
