#!/bin/bash

# pi-coordination install script
# Creates symlinks from ~/.pi/agent/ to this repo

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="$HOME/.pi/agent"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

uninstall() {
    log "Uninstalling pi-coordination..."
    
    # Remove coordinate tool symlink
    if [ -L "$PI_AGENT_DIR/tools/coordinate" ]; then
        rm "$PI_AGENT_DIR/tools/coordinate"
        log "Removed tools/coordinate symlink"
    fi
    
    # Remove runner.ts symlink (careful - might be used by subagent)
    if [ -L "$PI_AGENT_DIR/tools/subagent/runner.ts" ]; then
        warn "tools/subagent/runner.ts is a symlink - removing"
        warn "Note: You may need to restore the original runner.ts for subagent"
        rm "$PI_AGENT_DIR/tools/subagent/runner.ts"
    fi
    
    # Remove agent symlinks
    if [ -L "$PI_AGENT_DIR/agents/coordinator.md" ]; then
        rm "$PI_AGENT_DIR/agents/coordinator.md"
        log "Removed agents/coordinator.md symlink"
    fi
    
    # Remove skill symlink
    if [ -L "$PI_AGENT_DIR/skills/coordination" ]; then
        rm "$PI_AGENT_DIR/skills/coordination"
        log "Removed skills/coordination symlink"
    fi
    
    log "Uninstall complete"
    exit 0
}

# Check for --uninstall flag
if [ "$1" = "--uninstall" ] || [ "$1" = "-u" ]; then
    uninstall
fi

log "Installing pi-coordination..."

# Ensure pi agent directories exist
mkdir -p "$PI_AGENT_DIR/tools"
mkdir -p "$PI_AGENT_DIR/tools/subagent"
mkdir -p "$PI_AGENT_DIR/agents"
mkdir -p "$PI_AGENT_DIR/skills"

# Create coordinate tool symlink
if [ -e "$PI_AGENT_DIR/tools/coordinate" ]; then
    if [ -L "$PI_AGENT_DIR/tools/coordinate" ]; then
        warn "tools/coordinate symlink exists, replacing..."
        rm "$PI_AGENT_DIR/tools/coordinate"
    else
        error "tools/coordinate exists and is not a symlink. Please remove it first."
    fi
fi
ln -s "$SCRIPT_DIR/tools/coordinate" "$PI_AGENT_DIR/tools/coordinate"
log "Linked tools/coordinate"

# Create runner.ts symlink (shared with subagent)
if [ -e "$PI_AGENT_DIR/tools/subagent/runner.ts" ]; then
    if [ -L "$PI_AGENT_DIR/tools/subagent/runner.ts" ]; then
        warn "tools/subagent/runner.ts symlink exists, replacing..."
        rm "$PI_AGENT_DIR/tools/subagent/runner.ts"
    else
        warn "tools/subagent/runner.ts exists as a file"
        warn "Backing up to runner.ts.bak and replacing..."
        mv "$PI_AGENT_DIR/tools/subagent/runner.ts" "$PI_AGENT_DIR/tools/subagent/runner.ts.bak"
    fi
fi
ln -s "$SCRIPT_DIR/tools/runner.ts" "$PI_AGENT_DIR/tools/subagent/runner.ts"
log "Linked tools/subagent/runner.ts"

# Create coordinator agent symlink
if [ -e "$PI_AGENT_DIR/agents/coordinator.md" ]; then
    if [ -L "$PI_AGENT_DIR/agents/coordinator.md" ]; then
        rm "$PI_AGENT_DIR/agents/coordinator.md"
    else
        warn "agents/coordinator.md exists, backing up..."
        mv "$PI_AGENT_DIR/agents/coordinator.md" "$PI_AGENT_DIR/agents/coordinator.md.bak"
    fi
fi
ln -s "$SCRIPT_DIR/agents/coordinator.md" "$PI_AGENT_DIR/agents/coordinator.md"
log "Linked agents/coordinator.md"

# Update worker.md if it exists (merge coordination section)
if [ -e "$PI_AGENT_DIR/agents/worker.md" ]; then
    if ! grep -q "Task: Coordination Worker" "$PI_AGENT_DIR/agents/worker.md"; then
        warn "agents/worker.md exists but missing coordination section"
        warn "You may want to manually add the coordination task section from:"
        warn "  $SCRIPT_DIR/agents/worker.md"
    else
        log "agents/worker.md already has coordination section"
    fi
else
    ln -s "$SCRIPT_DIR/agents/worker.md" "$PI_AGENT_DIR/agents/worker.md"
    log "Linked agents/worker.md"
fi

# Create coordination skill symlink
if [ -e "$PI_AGENT_DIR/skills/coordination" ]; then
    if [ -L "$PI_AGENT_DIR/skills/coordination" ]; then
        rm "$PI_AGENT_DIR/skills/coordination"
    else
        warn "skills/coordination exists, backing up..."
        mv "$PI_AGENT_DIR/skills/coordination" "$PI_AGENT_DIR/skills/coordination.bak"
    fi
fi
ln -s "$SCRIPT_DIR/skills/coordination" "$PI_AGENT_DIR/skills/coordination"
log "Linked skills/coordination"

log ""
log "Installation complete!"
log ""
log "The coordinate tool is now available. Try:"
log "  coordinate({ plan: './plan.md', agents: ['worker', 'worker'] })"
