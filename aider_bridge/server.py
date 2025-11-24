#!/usr/bin/env python3
"""
Aider Bridge Server - JSON-RPC 2.0 over stdio
Wraps Aider's core functionality for Electron integration
"""

import sys
import json
import traceback
from typing import Optional, List, Dict, Any
from pathlib import Path

# Aider imports
try:
    from aider.coders import Coder
    from aider.models import Model
    from aider.io import InputOutput
except ImportError:
    print("ERROR: Aider not installed. Run: pip install aider-chat", file=sys.stderr)
    sys.exit(1)


class AiderBridge:
    """Bridge between Electron and Aider via JSON-RPC"""
    
    def __init__(self):
        self.coder: Optional[Coder] = None
        self.io: Optional[InputOutput] = None
        self.repo_path: Optional[Path] = None
        self.model: Optional[Model] = None
        
    def initialize(self, repo_path: str, model_name: str = "gpt-4") -> Dict[str, Any]:
        """
        Initialize Aider with a repository and model
        
        Args:
            repo_path: Path to git repository
            model_name: Model identifier (e.g., "gpt-4", "claude-3-opus")
            
        Returns:
            Success status and repo info
        """
        try:
            self.repo_path = Path(repo_path).resolve()
            
            if not self.repo_path.exists():
                return {
                    "success": False,
                    "error": f"Repository path does not exist: {repo_path}"
                }
            
            # Create InputOutput instance for capturing output
            self.io = InputOutput(
                yes=True,  # Auto-confirm
                chat_history_file=None
            )
            
            # Initialize model
            self.model = Model(model_name)
            
            # Create Coder instance
            self.coder = Coder.create(
                main_model=self.model,
                io=self.io,
                fnames=[],  # Start with no files
                auto_commits=True,
                dirty_commits=True,
                git_dname=str(self.repo_path)
            )
            
            return {
                "success": True,
                "repo_path": str(self.repo_path),
                "model": model_name,
                "files_in_context": []
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def run_prompt(self, message: str) -> Dict[str, Any]:
        """
        Send a prompt to Aider and get response
        
        Args:
            message: The prompt/instruction for Aider
            
        Returns:
            Response text and any file changes made
        """
        if not self.coder:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            # Run the prompt through Aider
            response = self.coder.run(message)
            
            # Get files that were modified
            modified_files = []
            if hasattr(self.coder, 'abs_fnames'):
                modified_files = [str(f) for f in self.coder.abs_fnames]
            
            return {
                "success": True,
                "response": response or "",
                "modified_files": modified_files,
                "files_in_context": self.get_context_files()
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def add_files(self, file_paths: List[str]) -> Dict[str, Any]:
        """
        Add files to Aider's context
        
        Args:
            file_paths: List of file paths to add
            
        Returns:
            Success status and updated file list
        """
        if not self.coder:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            # Convert to absolute paths
            abs_paths = []
            for fp in file_paths:
                abs_path = Path(fp).resolve()
                if abs_path.exists():
                    abs_paths.append(str(abs_path))
                else:
                    self._send_notification("warning", f"File not found: {fp}")
            
            # Add files to coder
            if abs_paths:
                self.coder.abs_fnames.update(abs_paths)
            
            return {
                "success": True,
                "files_added": abs_paths,
                "files_in_context": self.get_context_files()
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def remove_files(self, file_paths: List[str]) -> Dict[str, Any]:
        """
        Remove files from Aider's context
        
        Args:
            file_paths: List of file paths to remove
            
        Returns:
            Success status and updated file list
        """
        if not self.coder:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            # Convert to absolute paths
            abs_paths = []
            for fp in file_paths:
                abs_path = Path(fp).resolve()
                abs_paths.append(str(abs_path))
            
            # Remove files from coder
            for fp in abs_paths:
                self.coder.abs_fnames.discard(fp)
            
            return {
                "success": True,
                "files_removed": abs_paths,
                "files_in_context": self.get_context_files()
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def get_repo_map(self) -> Dict[str, Any]:
        """
        Get the repository map from Aider
        
        Returns:
            Repository structure and file information
        """
        if not self.coder:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            repo_map = ""
            if hasattr(self.coder, 'get_repo_map'):
                repo_map = self.coder.get_repo_map()
            
            return {
                "success": True,
                "repo_map": repo_map,
                "files_in_context": self.get_context_files()
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def set_test_cmd(self, command: str) -> Dict[str, Any]:
        """
        Configure auto-test command
        
        Args:
            command: Shell command to run tests
            
        Returns:
            Success status
        """
        if not self.coder:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            self.coder.test_cmd = command
            
            return {
                "success": True,
                "test_cmd": command
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def set_lint_cmd(self, command: str) -> Dict[str, Any]:
        """
        Configure auto-lint command
        
        Args:
            command: Shell command to run linter
            
        Returns:
            Success status
        """
        if not self.coder:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            self.coder.lint_cmd = command
            
            return {
                "success": True,
                "lint_cmd": command
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def get_context_files(self) -> List[str]:
        """Get list of files currently in context"""
        if self.coder and hasattr(self.coder, 'abs_fnames'):
            return list(self.coder.abs_fnames)
        return []
    
    def shutdown(self) -> Dict[str, Any]:
        """
        Shutdown Aider and cleanup
        
        Returns:
            Success status
        """
        try:
            if self.coder:
                # Cleanup
                self.coder = None
                self.io = None
                self.model = None
            
            return {
                "success": True,
                "message": "Shutdown complete"
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def _send_notification(self, level: str, message: str):
        """Send a notification to the client"""
        notification = {
            "jsonrpc": "2.0",
            "method": "notification",
            "params": {
                "level": level,
                "message": message
            }
        }
        print(json.dumps(notification), flush=True)


class JSONRPCServer:
    """JSON-RPC 2.0 Server over stdio"""
    
    def __init__(self):
        self.bridge = AiderBridge()
        self.running = True
        
    def handle_request(self, request_str: str) -> Optional[str]:
        """
        Handle a JSON-RPC request
        
        Args:
            request_str: JSON-RPC request string
            
        Returns:
            JSON-RPC response string or None for notifications
        """
        try:
            request = json.loads(request_str)
            
            # Validate JSON-RPC 2.0 format
            if request.get("jsonrpc") != "2.0":
                return self.error_response(None, -32600, "Invalid Request")
            
            method = request.get("method")
            params = request.get("params", {})
            request_id = request.get("id")
            
            # Notification (no response needed)
            if request_id is None:
                return None
            
            # Route to method
            if not hasattr(self.bridge, method):
                return self.error_response(request_id, -32601, f"Method not found: {method}")
            
            # Call method
            method_func = getattr(self.bridge, method)
            
            if isinstance(params, dict):
                result = method_func(**params)
            elif isinstance(params, list):
                result = method_func(*params)
            else:
                result = method_func()
            
            # Return success response
            return json.dumps({
                "jsonrpc": "2.0",
                "result": result,
                "id": request_id
            })
            
        except json.JSONDecodeError:
            return self.error_response(None, -32700, "Parse error")
        except TypeError as e:
            return self.error_response(request.get("id"), -32602, f"Invalid params: {str(e)}")
        except Exception as e:
            return self.error_response(
                request.get("id"),
                -32603,
                f"Internal error: {str(e)}",
                {"traceback": traceback.format_exc()}
            )
    
    def error_response(self, request_id, code: int, message: str, data=None) -> str:
        """Generate JSON-RPC error response"""
        error = {
            "jsonrpc": "2.0",
            "error": {
                "code": code,
                "message": message
            },
            "id": request_id
        }
        if data:
            error["error"]["data"] = data
        return json.dumps(error)
    
    def run(self):
        """Main server loop - read from stdin, write to stdout"""
        # Send ready signal
        print(json.dumps({"jsonrpc": "2.0", "method": "ready", "params": {}}), flush=True)
        
        # Read requests line by line
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            
            # Handle shutdown
            if line == "__EXIT__":
                self.bridge.shutdown()
                break
            
            # Process request
            response = self.handle_request(line)
            if response:
                print(response, flush=True)


def main():
    """Entry point"""
    server = JSONRPCServer()
    server.run()


if __name__ == "__main__":
    main()

