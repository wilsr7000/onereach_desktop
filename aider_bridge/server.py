#!/usr/bin/env python3
"""
Aider Bridge Server - JSON-RPC 2.0 over stdio
Wraps Aider's core functionality for Electron integration
"""

import sys
import os
import json
import time
import traceback
import threading
from typing import Optional, List, Dict, Any
from pathlib import Path

# Track if aider is available
AIDER_AVAILABLE = False
AIDER_IMPORT_ERROR = None

# Aider imports - graceful handling if not installed
try:
    from aider.coders import Coder
    from aider.models import Model
    from aider.io import InputOutput
    AIDER_AVAILABLE = True
except ImportError as e:
    AIDER_IMPORT_ERROR = str(e)
    # Don't exit - allow check_installation to report the error
    Coder = None
    Model = None
    InputOutput = None


class SandboxViolationError(Exception):
    """Raised when a file operation attempts to escape the sandbox"""
    pass


class AiderBridge:
    """Bridge between Electron and Aider via JSON-RPC"""
    
    def __init__(self):
        self.coder: Optional[Coder] = None
        self.io: Optional[InputOutput] = None
        self.repo_path: Optional[Path] = None
        self.model: Optional[Model] = None
        # Sandbox configuration
        self.sandbox_root: Optional[Path] = None  # If set, restricts all file operations
        self.read_only_files: List[str] = []  # Absolute paths that can be read but not written
        self.branch_id: Optional[str] = None  # For logging purposes
    
    def set_sandbox(self, sandbox_root: str, read_only_files: List[str] = None, branch_id: str = None) -> Dict[str, Any]:
        """
        Configure sandbox restrictions for this Aider instance
        
        Args:
            sandbox_root: Root directory - all write operations restricted to this path
            read_only_files: List of absolute paths that can be read but not written
            branch_id: Identifier for this branch (for logging)
            
        Returns:
            Success status
        """
        try:
            self.sandbox_root = Path(sandbox_root).resolve()
            self.read_only_files = [str(Path(f).resolve()) for f in (read_only_files or [])]
            self.branch_id = branch_id
            
            if not self.sandbox_root.exists():
                return {
                    "success": False,
                    "error": f"Sandbox root does not exist: {sandbox_root}"
                }
            
            print(f"[GSX-Python] Sandbox configured:", file=sys.stderr, flush=True)
            print(f"[GSX-Python]   Root: {self.sandbox_root}", file=sys.stderr, flush=True)
            print(f"[GSX-Python]   Read-only files: {len(self.read_only_files)}", file=sys.stderr, flush=True)
            print(f"[GSX-Python]   Branch ID: {self.branch_id}", file=sys.stderr, flush=True)
            
            return {
                "success": True,
                "sandbox_root": str(self.sandbox_root),
                "read_only_files": self.read_only_files,
                "branch_id": self.branch_id
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def _validate_path(self, file_path: str, for_write: bool = False) -> Path:
        """
        Validate that a path is within the sandbox and allowed
        
        Args:
            file_path: Path to validate
            for_write: If True, also check it's not in read-only list
            
        Returns:
            Resolved absolute path
            
        Raises:
            SandboxViolationError: If path escapes sandbox or write to read-only
        """
        resolved = Path(file_path).resolve()
        
        # If no sandbox, allow everything
        if not self.sandbox_root:
            return resolved
        
        # Check if within sandbox
        try:
            resolved.relative_to(self.sandbox_root)
            # Path is within sandbox - allowed
            return resolved
        except ValueError:
            # Path is outside sandbox
            pass
        
        # Check if it's an allowed read-only file (only for read operations)
        if not for_write and str(resolved) in self.read_only_files:
            return resolved
        
        # Path escapes sandbox
        if for_write:
            raise SandboxViolationError(
                f"Write operation blocked - path escapes sandbox: {file_path}\n"
                f"Sandbox root: {self.sandbox_root}\n"
                f"Branch: {self.branch_id or 'unknown'}"
            )
        else:
            raise SandboxViolationError(
                f"Read operation blocked - path escapes sandbox: {file_path}\n"
                f"Sandbox root: {self.sandbox_root}\n"
                f"Allowed read-only files: {self.read_only_files}\n"
                f"Branch: {self.branch_id or 'unknown'}"
            )
        
    def initialize(self, repo_path: str, model_name: str = "gpt-4") -> Dict[str, Any]:
        """
        Initialize Aider with a repository and model
        
        Args:
            repo_path: Path to git repository
            model_name: Model identifier (e.g., "gpt-4", "claude-3-opus")
            
        Returns:
            Success status and repo info
        """
        # Check if aider is available
        if not AIDER_AVAILABLE:
            return {
                "success": False,
                "error": f"Aider is not installed. {AIDER_IMPORT_ERROR or 'Run: pip install aider-chat'}",
                "install_instructions": "pip install aider-chat"
            }
        
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
            # Normalize model names for litellm/aider:
            # Many aider installs route LLM calls via LiteLLM, which requires provider-qualified
            # model names (e.g. "anthropic/claude-...") for Claude models.
            normalized_model_name = model_name
            if isinstance(normalized_model_name, str):
                normalized_model_name = normalized_model_name.strip()
                if normalized_model_name.startswith("claude-") and "/" not in normalized_model_name:
                    normalized_model_name = f"anthropic/{normalized_model_name}"
            if normalized_model_name != model_name:
                print(
                    f"[GSX-Python] Normalized model_name '{model_name}' -> '{normalized_model_name}'",
                    file=sys.stderr,
                    flush=True,
                )
            self.model = Model(normalized_model_name)
            
            # Change to repo directory for git operations
            import os
            original_cwd = os.getcwd()
            os.chdir(str(self.repo_path))
            
            try:
                # Create Coder instance
                # Note: Different aider versions have different APIs
                try:
                    self.coder = Coder.create(
                        main_model=self.model,
                        io=self.io,
                        fnames=[],  # Start with no files
                        auto_commits=True,
                        dirty_commits=True,
                        auto_lint=False,
                        edit_format="diff",  # Use diff-based editing for targeted changes
                        suggest_shell_commands=False,
                        show_diffs=True,  # Show what changed
                    )
                except TypeError as e:
                    print(f"[GSX Create] Fallback to simpler Coder.create: {e}", file=sys.stderr)
                    # Fallback for older/newer API versions
                    self.coder = Coder.create(
                        main_model=self.model,
                        io=self.io,
                        auto_lint=False,
                        edit_format="diff",
                    )
            finally:
                os.chdir(original_cwd)
            
            return {
                "success": True,
                "repo_path": str(self.repo_path),
                "model": normalized_model_name,
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
        import time
        start_time = time.time()
        print(f"[GSX-Python] >>> run_prompt called", file=sys.stderr, flush=True)
        print(f"[GSX-Python]     Message length: {len(message)} chars", file=sys.stderr, flush=True)
        print(f"[GSX-Python]     Message preview: {message[:100]}...", file=sys.stderr, flush=True)
        
        if not AIDER_AVAILABLE:
            print(f"[GSX-Python] !!! ERROR: Aider not installed", file=sys.stderr, flush=True)
            return {
                "success": False,
                "error": f"Aider is not installed. {AIDER_IMPORT_ERROR or 'Run: pip install aider-chat'}"
            }
        
        if not self.coder:
            print(f"[GSX-Python] !!! ERROR: Not initialized", file=sys.stderr, flush=True)
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            import os
            from pathlib import Path
            
            # Use sandbox root if set for file tracking
            scan_root = self.sandbox_root if self.sandbox_root else self.repo_path
            
            print(f"[GSX-Python]     Scanning files before prompt...", file=sys.stderr, flush=True)
            print(f"[GSX-Python]     Scan root: {scan_root}", file=sys.stderr, flush=True)
            if self.sandbox_root:
                print(f"[GSX-Python]     SANDBOXED MODE - Branch: {self.branch_id}", file=sys.stderr, flush=True)
            
            # Track files before running prompt
            files_before = set()
            if scan_root and scan_root.exists():
                for f in scan_root.rglob('*'):
                    if f.is_file() and not any(p in str(f) for p in ['.git', '__pycache__', 'node_modules', '.aider']):
                        files_before.add(str(f))
            print(f"[GSX-Python]     Files before: {len(files_before)}", file=sys.stderr, flush=True)
            
            # Run the prompt through Aider
            print(f"[GSX-Python]     Calling coder.run()...", file=sys.stderr, flush=True)
            coder_start = time.time()
            response = self.coder.run(message)
            coder_elapsed = time.time() - coder_start
            print(f"[GSX-Python]     coder.run() completed in {coder_elapsed:.2f}s", file=sys.stderr, flush=True)
            print(f"[GSX-Python]     Response length: {len(response) if response else 0} chars", file=sys.stderr, flush=True)
            
            print(f"[GSX-Python]     Scanning files after prompt...", file=sys.stderr, flush=True)
            # Track files after running prompt (within sandbox if set)
            files_after = set()
            if scan_root and scan_root.exists():
                for f in scan_root.rglob('*'):
                    if f.is_file() and not any(p in str(f) for p in ['.git', '__pycache__', 'node_modules', '.aider']):
                        files_after.add(str(f))
            print(f"[GSX-Python]     Files after: {len(files_after)}", file=sys.stderr, flush=True)
            
            # Determine new and modified files
            new_files = files_after - files_before
            print(f"[GSX-Python]     New files: {len(new_files)}", file=sys.stderr, flush=True)
            for f in new_files:
                print(f"[GSX-Python]       + {f}", file=sys.stderr, flush=True)
            
            # Get files in context that may have been modified
            modified_files = []
            if hasattr(self.coder, 'abs_fnames'):
                modified_files = [str(f) for f in self.coder.abs_fnames]
            print(f"[GSX-Python]     Modified files in context: {len(modified_files)}", file=sys.stderr, flush=True)
            
            # Build file_details with action info
            file_details = []
            for f in new_files:
                file_details.append({
                    "name": Path(f).name,
                    "path": f,
                    "action": "created"
                })
            for f in modified_files:
                if f not in new_files:
                    file_details.append({
                        "name": Path(f).name,
                        "path": f,
                        "action": "modified"
                    })
            
            elapsed = time.time() - start_time
            print(f"[GSX-Python] <<< run_prompt completed in {elapsed:.2f}s", file=sys.stderr, flush=True)
            print(f"[GSX-Python]     Success: True, file_details: {len(file_details)}", file=sys.stderr, flush=True)
            
            return {
                "success": True,
                "response": response or "",
                "modified_files": modified_files,
                "new_files": list(new_files),
                "file_details": file_details,
                "files_in_context": self.get_context_files()
            }
            
        except Exception as e:
            elapsed = time.time() - start_time
            print(f"[GSX-Python] !!! run_prompt EXCEPTION after {elapsed:.2f}s: {str(e)}", file=sys.stderr, flush=True)
            print(f"[GSX-Python]     Traceback: {traceback.format_exc()}", file=sys.stderr, flush=True)
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
        if not AIDER_AVAILABLE:
            return {
                "success": False,
                "error": f"Aider is not installed. {AIDER_IMPORT_ERROR or 'Run: pip install aider-chat'}"
            }
        
        if not self.coder:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            # Convert to absolute paths with sandbox validation
            abs_paths = []
            blocked_paths = []
            
            for fp in file_paths:
                try:
                    # Validate path is within sandbox (read access)
                    abs_path = self._validate_path(fp, for_write=False)
                    if abs_path.exists():
                        abs_paths.append(str(abs_path))
                    else:
                        self._send_notification("warning", f"File not found: {fp}")
                except SandboxViolationError as e:
                    blocked_paths.append(fp)
                    self._send_notification("error", f"Sandbox violation: {fp}")
                    print(f"[GSX-Python] SANDBOX BLOCKED add_files: {fp}", file=sys.stderr, flush=True)
            
            # Add files to coder
            if abs_paths:
                self.coder.abs_fnames.update(abs_paths)
            
            result = {
                "success": True,
                "files_added": abs_paths,
                "files_in_context": self.get_context_files()
            }
            
            if blocked_paths:
                result["blocked_by_sandbox"] = blocked_paths
                result["warning"] = f"{len(blocked_paths)} files blocked by sandbox"
            
            return result
            
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
        if not AIDER_AVAILABLE:
            return {
                "success": False,
                "error": f"Aider is not installed. {AIDER_IMPORT_ERROR or 'Run: pip install aider-chat'}"
            }
        
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
        if not AIDER_AVAILABLE:
            return {
                "success": False,
                "error": f"Aider is not installed. {AIDER_IMPORT_ERROR or 'Run: pip install aider-chat'}"
            }
        
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

    def search_code(self, pattern: str, file_glob: str = None) -> Dict[str, Any]:
        """
        Search for a pattern in the codebase using grep-like functionality
        
        Args:
            pattern: Regex pattern to search for
            file_glob: Optional file pattern to limit search (e.g., "*.py", "*.js")
            
        Returns:
            List of matches with file, line number, and content
        """
        import subprocess
        import re
        
        if not self.repo_path:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            # Use sandbox root if set, otherwise repo_path
            search_root = self.sandbox_root if self.sandbox_root else self.repo_path
            
            # Build grep command - search only within sandbox
            cmd = ['grep', '-rn', '--include=' + (file_glob or '*'), pattern, str(search_root)]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            
            matches = []
            for line in result.stdout.strip().split('\n'):
                if line and ':' in line:
                    parts = line.split(':', 2)
                    if len(parts) >= 3:
                        matches.append({
                            "file": parts[0].replace(str(search_root) + '/', ''),
                            "line": int(parts[1]) if parts[1].isdigit() else 0,
                            "content": parts[2].strip()
                        })
            
            return {
                "success": True,
                "pattern": pattern,
                "matches": matches[:50],  # Limit to 50 matches
                "total_matches": len(matches),
                "search_root": str(search_root)
            }
            
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "error": "Search timed out"
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    def find_definition(self, symbol: str) -> Dict[str, Any]:
        """
        Find where a function, class, or variable is defined
        
        Args:
            symbol: The name of the symbol to find
            
        Returns:
            List of definition locations
        """
        import subprocess
        
        if not self.repo_path:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            # Use sandbox root if set, otherwise repo_path
            search_root = self.sandbox_root if self.sandbox_root else self.repo_path
            
            # Search for common definition patterns
            patterns = [
                f"def {symbol}",           # Python function
                f"class {symbol}",         # Python/JS class
                f"function {symbol}",      # JS function
                f"const {symbol}",         # JS const
                f"let {symbol}",           # JS let
                f"var {symbol}",           # JS var
                rf"{symbol}\s*=\s*function",  # JS function expression
                rf"{symbol}\s*:\s*function",  # JS object method
                rf"async\s+{symbol}",      # Async function
            ]
            
            all_matches = []
            for pattern in patterns:
                cmd = ['grep', '-rn', '-E', pattern, str(search_root)]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                
                for line in result.stdout.strip().split('\n'):
                    if line and ':' in line:
                        parts = line.split(':', 2)
                        if len(parts) >= 3:
                            all_matches.append({
                                "file": parts[0].replace(str(search_root) + '/', ''),
                                "line": int(parts[1]) if parts[1].isdigit() else 0,
                                "content": parts[2].strip(),
                                "pattern": pattern
                            })
            
            # Remove duplicates
            seen = set()
            unique_matches = []
            for m in all_matches:
                key = (m["file"], m["line"])
                if key not in seen:
                    seen.add(key)
                    unique_matches.append(m)
            
            return {
                "success": True,
                "symbol": symbol,
                "definitions": unique_matches[:20],
                "search_root": str(search_root)
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    def find_usages(self, symbol: str) -> Dict[str, Any]:
        """
        Find all usages of a symbol in the codebase
        
        Args:
            symbol: The name to search for
            
        Returns:
            List of usage locations
        """
        # Use search_code with word boundaries
        return self.search_code(f"\\b{symbol}\\b")
    
    def read_file_section(self, file_path: str, start_line: int, end_line: int) -> Dict[str, Any]:
        """
        Read a specific section of a file
        
        Args:
            file_path: Path to the file (relative to repo)
            start_line: Starting line number (1-indexed)
            end_line: Ending line number (1-indexed)
            
        Returns:
            The content of the specified lines
        """
        import os
        
        if not self.repo_path:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        try:
            full_path = os.path.join(str(self.repo_path), file_path)
            
            # Validate path is within sandbox (read access)
            try:
                validated_path = self._validate_path(full_path, for_write=False)
            except SandboxViolationError as e:
                print(f"[GSX-Python] SANDBOX BLOCKED read_file_section: {file_path}", file=sys.stderr, flush=True)
                return {
                    "success": False,
                    "error": f"Sandbox violation: {str(e)}"
                }
            
            if not validated_path.exists():
                return {
                    "success": False,
                    "error": f"File not found: {file_path}"
                }
            
            with open(str(validated_path), 'r') as f:
                lines = f.readlines()
            
            # Adjust for 1-indexed line numbers
            start_idx = max(0, start_line - 1)
            end_idx = min(len(lines), end_line)
            
            selected_lines = []
            for i in range(start_idx, end_idx):
                selected_lines.append({
                    "line": i + 1,
                    "content": lines[i].rstrip()
                })
            
            return {
                "success": True,
                "file": file_path,
                "start_line": start_line,
                "end_line": end_line,
                "lines": selected_lines
            }
            
        except SandboxViolationError:
            raise  # Re-raise sandbox errors
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }


    def set_test_cmd(self, command: str) -> Dict[str, Any]:
        """
        Configure auto-test command
        
        Args:
            command: Shell command to run tests
            
        Returns:
            Success status
        """
        if not AIDER_AVAILABLE:
            return {
                "success": False,
                "error": f"Aider is not installed. {AIDER_IMPORT_ERROR or 'Run: pip install aider-chat'}"
            }
        
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
        if not AIDER_AVAILABLE:
            return {
                "success": False,
                "error": f"Aider is not installed. {AIDER_IMPORT_ERROR or 'Run: pip install aider-chat'}"
            }
        
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
    
    def ping(self) -> Dict[str, Any]:
        """
        Health check ping - returns pong with timestamp and status
        
        Returns:
            Pong response with server status
        """
        return {
            "success": True,
            "pong": True,
            "timestamp": time.time(),
            "initialized": self.coder is not None,
            "aider_available": AIDER_AVAILABLE,
            "pid": os.getpid(),
            "files_in_context": len(self.get_context_files()) if self.coder else 0
        }
    
    def check_installation(self) -> Dict[str, Any]:
        """
        Check if aider-chat is properly installed
        
        Returns:
            Installation status with helpful error messages
        """
        result = {
            "success": True,
            "aider_installed": AIDER_AVAILABLE,
            "aider_version": None,
            "python_version": sys.version,
            "python_executable": sys.executable,
            "missing_packages": [],
            "error": AIDER_IMPORT_ERROR,
            "install_instructions": None
        }
        
        if AIDER_AVAILABLE:
            try:
                import aider
                result["aider_version"] = getattr(aider, '__version__', 'unknown')
            except:
                pass
        else:
            result["success"] = False
            result["missing_packages"].append("aider-chat")
            result["install_instructions"] = {
                "pip": "pip install aider-chat",
                "pip3": "pip3 install aider-chat",
                "pipx": "pipx install aider-chat",
                "note": "Make sure you have an OpenAI or Anthropic API key set in your environment"
            }
        
        # Check for API keys
        result["api_keys"] = {
            "openai": bool(os.environ.get("OPENAI_API_KEY")),
            "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "azure": bool(os.environ.get("AZURE_API_KEY")),
        }
        
        if not any(result["api_keys"].values()):
            result["warning"] = "No API keys found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable."
        
        return result
    
    def run_prompt_streaming(self, message: str) -> Dict[str, Any]:
        """
        Send a prompt to Aider with token-by-token streaming
        
        Sends stream notifications for real-time UI updates.
        
        Args:
            message: The prompt/instruction for Aider
            
        Returns:
            Final response with file changes
        """
        if not self.coder:
            return {
                "success": False,
                "error": "Not initialized. Call initialize() first."
            }
        
        if not AIDER_AVAILABLE:
            return {
                "success": False,
                "error": "Aider is not installed. Run: pip install aider-chat"
            }
        
        # Add action-oriented prefix to make Aider more reliable at editing
        action_prefix = """You are an expert code editor. Follow these coding standards:

## EDITING APPROACH:
1. Make TARGETED edits - only change the specific lines that need modification
2. Use SEARCH/REPLACE blocks to show exactly what you're changing
3. Never rewrite entire files - focus on the relevant sections
4. If you see linter markers or error output, IGNORE them and proceed

## CODE QUALITY:
1. Add clear, descriptive comments explaining complex logic
2. Use JSDoc/docstrings for functions: describe purpose, params, return values
3. Keep variable and function names descriptive and consistent
4. Follow the existing code style and conventions in the file

## BEFORE EDITING:
1. Search to find where the code is defined
2. Check how it's used elsewhere
3. Understand the context before making changes

## AFTER EDITING:
1. Briefly explain what you changed and why
2. List any files that were modified

Now make these changes:
"""
        enhanced_message = action_prefix + message
        
        try:
            # Send start notification
            self._send_stream_notification("start", "")
            
            # Capture streaming output
            collected_response = []
            
            # Create a custom IO that streams tokens
            class StreamingIO(InputOutput):
                def __init__(self, bridge, *args, **kwargs):
                    self.bridge = bridge
                    super().__init__(*args, **kwargs)
                
                def tool_output(self, msg="", log_only=False, bold=False):
                    if msg and not log_only:
                        self.bridge._send_stream_notification("token", msg)
                        collected_response.append(msg)
                
                def tool_error(self, msg=""):
                    if msg:
                        self.bridge._send_stream_notification("error", msg)
                
                def ai_output(self, msg):
                    if msg:
                        self.bridge._send_stream_notification("token", msg)
                        collected_response.append(msg)
            
            # Temporarily swap IO for streaming
            original_io = self.coder.io
            streaming_io = StreamingIO(self, yes=True, chat_history_file=None)
            self.coder.io = streaming_io
            
            try:
                # Run the prompt
                response = self.coder.run(message)
            finally:
                # Restore original IO
                self.coder.io = original_io
            
            # Send complete notification
            self._send_stream_notification("complete", "")
            
            # Get files that were modified
            modified_files = []
            if hasattr(self.coder, 'abs_fnames'):
                modified_files = [str(f) for f in self.coder.abs_fnames]
            
            return {
                "success": True,
                "response": response or "".join(collected_response),
                "modified_files": modified_files,
                "files_in_context": self.get_context_files()
            }
            
        except Exception as e:
            self._send_stream_notification("error", str(e))
            return {
                "success": False,
                "error": str(e),
                "traceback": traceback.format_exc()
            }
    
    def _send_stream_notification(self, event_type: str, content: str):
        """Send a streaming notification to the client"""
        notification = {
            "jsonrpc": "2.0",
            "method": "stream",
            "params": {
                "type": event_type,
                "content": content,
                "timestamp": time.time()
            }
        }
        print(json.dumps(notification), flush=True)
    
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
        # Send ready signal to stderr (for process monitoring)
        print("AIDER_BRIDGE_READY", file=sys.stderr, flush=True)
        # Send ready signal to stdout (JSON-RPC notification)
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

