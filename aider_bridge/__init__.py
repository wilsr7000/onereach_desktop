"""
Aider Bridge - Python sidecar for AI pair programming

This module provides a JSON-RPC server that wraps Aider's core functionality
for use with Electron applications.

Usage:
    python -m aider_bridge.server

Or import directly:
    from aider_bridge.server import AiderBridgeServer
"""

__version__ = "1.0.0"
__author__ = "OneReach"

from .server import AiderBridgeServer, main

__all__ = ["AiderBridgeServer", "main", "__version__"]

