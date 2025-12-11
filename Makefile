CXX = g++
CXXFLAGS = -O2 -Wall
LDFLAGS = -lws2_32 -luser32 -lkernel32 -mwindows
TARGET = KeyBlocker.exe
SOURCES = KeyBlocker.cpp

all: $(TARGET)

$(TARGET): $(SOURCES)
	$(CXX) $(CXXFLAGS) -o $(TARGET) $(SOURCES) $(LDFLAGS)
	@echo Build complete: $(TARGET)

clean:
	rm -f $(TARGET) *.o

.PHONY: all clean
