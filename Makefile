CXX = g++
SWIFTC = swiftc
CXXFLAGS = -O2 -Wall
LDFLAGS = -lws2_32 -luser32 -lkernel32 -mwindows
WIN_TARGET = KeyBlocker.exe
MAC_TARGET = KeyBlocker
WIN_SOURCES = KeyBlocker.cpp
MAC_SOURCES = KeyBlocker.swift

all: $(WIN_TARGET)

$(WIN_TARGET): $(WIN_SOURCES)
	$(CXX) $(CXXFLAGS) -o $(WIN_TARGET) $(WIN_SOURCES) $(LDFLAGS)
	@echo Build complete: $(WIN_TARGET)

mac: $(MAC_TARGET)

$(MAC_TARGET): $(MAC_SOURCES)
	$(SWIFTC) -o $(MAC_TARGET) $(MAC_SOURCES)
	@echo Build complete: $(MAC_TARGET)

clean:
	rm -f $(WIN_TARGET) $(MAC_TARGET) *.o

.PHONY: all mac clean
