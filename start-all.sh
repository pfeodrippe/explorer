#!/bin/bash

OPENCODE_PORT=4096
BRIDGE_PORT=27891
NATIVE_PORT=27750

echo "=== Flecs Explorer Complete Setup ==="
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Stopping all servers..."
    kill $OPENCODE_PID 2>/dev/null
    kill $NATIVE_PID 2>/dev/null
    kill $BRIDGE_PID 2>/dev/null
    kill $HTTP_PID 2>/dev/null
    exit
}

trap cleanup INT TERM

# Kill only processes on our specific ports
echo "Cleaning up processes on our ports..."
lsof -ti:$OPENCODE_PORT | xargs kill -9 2>/dev/null || true
lsof -ti:$BRIDGE_PORT | xargs kill -9 2>/dev/null || true
lsof -ti:$NATIVE_PORT | xargs kill -9 2>/dev/null || true
sleep 1

# Step 1: Build native server
echo ""
echo "1. Building native Flecs server..."
if [ ! -f bin/*/flecs_explorer ]; then
    echo "   Running bake build..."
    bake > /tmp/bake.log 2>&1
    if [ $? -ne 0 ]; then
        echo "   ❌ Build failed. Check /tmp/bake.log"
        cat /tmp/bake.log
        exit 1
    fi
    echo "   ✅ Build complete"
else
    echo "   ✅ Already built"
fi

# Find the binary
BINARY=$(find bin -name flecs_explorer -type f 2>/dev/null | head -1)
if [ -z "$BINARY" ]; then
    echo "   ❌ Binary not found after build"
    exit 1
fi

# Step 2: Start native server
echo ""
echo "2. Starting native Flecs REST server..."
$BINARY > /tmp/native.log 2>&1 &
NATIVE_PID=$!
sleep 2

if ! kill -0 $NATIVE_PID 2>/dev/null; then
    echo "   ❌ Native server failed to start"
    cat /tmp/native.log
    exit 1
fi

echo "   ✅ Native server running on http://localhost:$NATIVE_PORT (PID: $NATIVE_PID)"

# Step 3: Start OpenCode server
echo ""
echo "3. Starting OpenCode server on port $OPENCODE_PORT..."
opencode serve --port $OPENCODE_PORT > /tmp/opencode.log 2>&1 &
OPENCODE_PID=$!
sleep 3

if ! kill -0 $OPENCODE_PID 2>/dev/null; then
    echo "   ❌ OpenCode server failed to start"
    cat /tmp/opencode.log
    cleanup
    exit 1
fi

echo "   ✅ OpenCode server running on http://127.0.0.1:$OPENCODE_PORT (PID: $OPENCODE_PID)"

# Step 4: Start AI bridge
echo ""
echo "4. Starting AI bridge on port $BRIDGE_PORT..."
OPENCODE_SERVER_URL=http://127.0.0.1:$OPENCODE_PORT \
FLECS_EXPLORER_AI_BRIDGE_PORT=$BRIDGE_PORT \
node tools/ai-bridge.js > /tmp/bridge.log 2>&1 &
BRIDGE_PID=$!
sleep 2

if ! kill -0 $BRIDGE_PID 2>/dev/null; then
    echo "   ❌ Bridge failed to start"
    cat /tmp/bridge.log
    cleanup
    exit 1
fi

echo "   ✅ AI bridge running on http://127.0.0.1:$BRIDGE_PORT (PID: $BRIDGE_PID)"

# Step 5: Start web server
echo ""
echo "5. Starting web server..."
python3 -m http.server 8000 --directory etc > /tmp/http.log 2>&1 &
HTTP_PID=$!
sleep 1

if ! kill -0 $HTTP_PID 2>/dev/null; then
    echo "   ❌ Web server failed to start"
    cat /tmp/http.log
    cleanup
    exit 1
fi

echo "   ✅ Web server running on http://localhost:8000 (PID: $HTTP_PID)"

# Success!
echo ""
echo "=== All Servers Running ==="
echo ""
echo "🌐 Open your browser: http://localhost:8000"
echo ""
echo "📍 Connection Info:"
echo "   Native Flecs API: http://localhost:$NATIVE_PORT"
echo "   OpenCode Server:  http://127.0.0.1:$OPENCODE_PORT"
echo "   AI Bridge:        http://127.0.0.1:$BRIDGE_PORT"
echo "   Web UI:           http://localhost:8000"
echo ""
echo "🎯 Next Steps:"
echo "   1. Go to 'Queries' tab"
echo "   2. Click 'Assistant' tab"
echo "   3. Select 'OpenCode CLI' provider"
echo "   4. Try: 'find all buildings with Position3'"
echo ""
echo "Press Ctrl+C to stop all servers"
echo ""

# Wait for interrupt
wait
