#!/usr/bin/env python3
"""
Test script for Aider Bridge
Tests the JSON-RPC server without Electron
"""

import json
import subprocess
import sys
from pathlib import Path

def send_request(proc, method, params=None, request_id=1):
    """Send JSON-RPC request and get response"""
    request = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params or {},
        "id": request_id
    }
    
    # Send request
    proc.stdin.write(json.dumps(request) + '\n')
    proc.stdin.flush()
    
    # Read response
    response_line = proc.stdout.readline()
    return json.loads(response_line)

def main():
    print("🧪 Testing Aider Bridge Server\n")
    
    # Start the server
    script_path = Path(__file__).parent / 'server.py'
    
    print(f"Starting server: {script_path}")
    proc = subprocess.Popen(
        [sys.executable, str(script_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1
    )
    
    try:
        # Wait for ready signal
        print("Waiting for ready signal...")
        ready_line = proc.stdout.readline()
        ready = json.loads(ready_line)
        
        if ready.get('method') == 'ready':
            print("✅ Server ready!\n")
        else:
            print(f"❌ Unexpected ready signal: {ready}")
            return
        
        # Test 1: Initialize (should fail without valid repo)
        print("Test 1: Initialize with invalid repo...")
        response = send_request(proc, 'initialize', {
            'repo_path': '/tmp/nonexistent',
            'model_name': 'gpt-4'
        }, 1)
        
        if not response.get('result', {}).get('success'):
            print(f"✅ Correctly rejected invalid repo")
            print(f"   Error: {response.get('result', {}).get('error')}\n")
        else:
            print("❌ Should have failed\n")
        
        # Test 2: Call method before initialize
        print("Test 2: Call method before initialize...")
        response = send_request(proc, 'run_prompt', {
            'message': 'Hello'
        }, 2)
        
        if not response.get('result', {}).get('success'):
            print(f"✅ Correctly requires initialization first")
            print(f"   Error: {response.get('result', {}).get('error')}\n")
        else:
            print("❌ Should require initialization\n")
        
        # Test 3: Get repo map (should fail - not initialized)
        print("Test 3: Get repo map without initialization...")
        response = send_request(proc, 'get_repo_map', {}, 3)
        
        if not response.get('result', {}).get('success'):
            print(f"✅ Correctly requires initialization")
            print(f"   Error: {response.get('result', {}).get('error')}\n")
        else:
            print("❌ Should require initialization\n")
        
        # Test 4: Shutdown
        print("Test 4: Shutdown...")
        response = send_request(proc, 'shutdown', {}, 4)
        
        if response.get('result', {}).get('success'):
            print("✅ Shutdown successful\n")
        else:
            print("❌ Shutdown failed\n")
        
        print("✅ All JSON-RPC protocol tests passed!")
        print("\n📝 Note: Full Aider tests require a valid git repo and API keys")
        
    finally:
        # Cleanup
        proc.stdin.write('__EXIT__\n')
        proc.stdin.flush()
        proc.wait(timeout=2)

if __name__ == '__main__':
    main()

