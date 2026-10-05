CXX ?= g++
CXXFLAGS ?= -O2 -std=c++20 -Wall -Wextra -pthread
BIN := daemon/omprd

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Linux)
LDLIBS += -lutil
endif

.PHONY: all clean test

all: $(BIN)

$(BIN): daemon/omprd.cpp daemon/crypto.hpp daemon/json.hpp daemon/rigfs.hpp linux/x11.hpp macos/mac.hpp windows/win.hpp daemon/stb_image_write.h
	$(CXX) $(CXXFLAGS) -o $@ daemon/omprd.cpp $(LDLIBS)

test: all
	python3 test/client.py

clean:
	rm -f $(BIN)
