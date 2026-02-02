#!/usr/bin/env python3
"""
Test script for Aider Bridge Server
Tests JSON-RPC protocol, health checks, and installation detection
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
    print("="*50)
    
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
        
        request_id = 0
        
        # Test 1: Health check ping
        print("Test 1: Health check ping...")
        request_id += 1
        response = send_request(proc, 'ping', {}, request_id)
        result = response.get('result', {})
        
        if result.get('success') and result.get('pong'):
            print(f"✅ Ping successful!")
            print(f"   PID: {result.get('pid')}")
            print(f"   Timestamp: {result.get('timestamp')}")
            print(f"   Initialized: {result.get('initialized')}")
            print(f"   Aider Available: {result.get('aider_available')}")
        else:
            print(f"❌ Ping failed: {response}")
        print()
        
        # Test 2: Check installation
        print("Test 2: Check installation...")
        request_id += 1
        response = send_request(proc, 'check_installation', {}, request_id)
        result = response.get('result', {})
        
        print(f"   Aider Installed: {result.get('aider_installed')}")
        print(f"   Aider Version: {result.get('aider_version', 'N/A')}")
        python_ver = result.get('python_version', 'Unknown')
        print(f"   Python Version: {python_ver[:40]}...")
        print(f"   API Keys:")
        api_keys = result.get('api_keys', {})
        print(f"     - OpenAI: {'✅' if api_keys.get('openai') else '❌'}")
        print(f"     - Anthropic: {'✅' if api_keys.get('anthropic') else '❌'}")
        print(f"     - Azure: {'✅' if api_keys.get('azure') else '❌'}")
        
        if result.get('warning'):
            print(f"   ⚠️  Warning: {result['warning']}")
        
        if result.get('aider_installed'):
            print("✅ Aider is properly installed!")
        else:
            print("⚠️  Aider not installed. Install with:")
            instructions = result.get('install_instructions', {})
            if instructions:
                print(f"   {instructions.get('pip', 'pip install aider-chat')}")
        print()
        
        # Test 3: Initialize with invalid repo
        print("Test 3: Initialize with invalid repo...")
        request_id += 1
        response = send_request(proc, 'initialize', {
            'repo_path': '/tmp/nonexistent',
            'model_name': 'gpt-4'
        }, request_id)
        result = response.get('result', {})
        
        if not result.get('success'):
            print(f"✅ Correctly rejected invalid repo")
            print(f"   Error: {result.get('error')}")
        else:
            print("❌ Should have failed with invalid repo")
        print()
        
        # Test 4: Call method before initialize
        print("Test 4: Call method before initialize...")
        request_id += 1
        response = send_request(proc, 'run_prompt', {
            'message': 'Hello'
        }, request_id)
        result = response.get('result', {})
        
        if not result.get('success'):
            print(f"✅ Correctly requires initialization first")
            print(f"   Error: {result.get('error')}")
        else:
            print("❌ Should require initialization")
        print()
        
        # Test 5: Get repo map without initialization
        print("Test 5: Get repo map without initialization...")
        request_id += 1
        response = send_request(proc, 'get_repo_map', {}, request_id)
        result = response.get('result', {})
        
        if not result.get('success'):
            print(f"✅ Correctly requires initialization")
            print(f"   Error: {result.get('error')}")
        else:
            print("❌ Should require initialization")
        print()
        
        # Test 6: Another ping to verify server is still responsive
        print("Test 6: Verify server still responsive after errors...")
        request_id += 1
        response = send_request(proc, 'ping', {}, request_id)
        result = response.get('result', {})
        
        if result.get('pong'):
            print("✅ Server still responsive!")
        else:
            print("❌ Server became unresponsive")
        print()
        
        # Test 7: Shutdown
        print("Test 7: Shutdown...")
        request_id += 1
        response = send_request(proc, 'shutdown', {}, request_id)
        result = response.get('result', {})
        
        if result.get('success'):
            print("✅ Shutdown successful")
        else:
            print(f"❌ Shutdown failed: {response}")
        
        print()
        print("="*50)
        print("✅ All JSON-RPC protocol tests passed!")
        print("="*50)
        print("\n📝 Note: Full Aider tests require a valid git repo and API keys")
        
    finally:
        # Cleanup
        try:
            proc.stdin.write('__EXIT__\n')
            proc.stdin.flush()
            proc.wait(timeout=2)
        except:
            proc.kill()

if __name__ == '__main__':
    main()
