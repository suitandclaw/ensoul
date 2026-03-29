#!/usr/bin/env bash
#
# harden-ssh.sh
#
# Two-phase SSH hardening for Ensoul cloud validators.
# Phase 1: Create ensoul user, add SSH key, install fail2ban, enable UFW.
# Phase 2: Disable root login and password auth (run AFTER verifying ensoul works).
#
# Usage:
#   Phase 1: ssh root@IP "bash -s" < scripts/harden-ssh.sh phase1 "ssh-ed25519 AAAA... user@host"
#   Phase 2: ssh ensoul@IP "sudo bash -s" < scripts/harden-ssh.sh phase2
#
# NEVER changes the SSH port. Port 22 only.
# NEVER runs systemctl restart ssh. Uses kill -HUP for config reload.
#

set -euo pipefail

PHASE="${1:-help}"
SSH_PUBKEY="${2:-}"

log() { echo "[$(date '+%H:%M:%S')] $1"; }

phase1() {
    if [ -z "$SSH_PUBKEY" ]; then
        echo "Error: SSH public key required for phase1"
        echo "Usage: bash harden-ssh.sh phase1 \"ssh-ed25519 AAAA... user@host\""
        exit 1
    fi

    log "Phase 1: Creating ensoul user and security baseline"

    # Create ensoul user with sudo
    if ! id ensoul >/dev/null 2>&1; then
        useradd -m -s /bin/bash -G sudo ensoul
        echo "ensoul ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ensoul
        log "Created ensoul user with passwordless sudo"
    else
        log "ensoul user already exists"
    fi

    # Install SSH key
    mkdir -p /home/ensoul/.ssh
    echo "$SSH_PUBKEY" >> /home/ensoul/.ssh/authorized_keys
    # Deduplicate
    sort -u /home/ensoul/.ssh/authorized_keys -o /home/ensoul/.ssh/authorized_keys
    chown -R ensoul:ensoul /home/ensoul/.ssh
    chmod 700 /home/ensoul/.ssh
    chmod 600 /home/ensoul/.ssh/authorized_keys
    log "SSH key installed for ensoul user"

    # Symlink chain data for ensoul user
    ln -sf /root/.cometbft-ensoul /home/ensoul/.cometbft-ensoul 2>/dev/null || true
    ln -sf /root/.ensoul /home/ensoul/.ensoul 2>/dev/null || true
    ln -sf /root/ensoul /home/ensoul/ensoul 2>/dev/null || true
    chmod 755 /root
    log "Chain data symlinked"

    # Install fail2ban
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban 2>/dev/null
    cat > /etc/fail2ban/jail.local << 'JAILEOF'
[sshd]
enabled = true
port = 22
maxretry = 3
bantime = 3600
findtime = 600
JAILEOF
    systemctl enable fail2ban
    systemctl restart fail2ban
    log "fail2ban installed and configured (3 attempts = 1 hour ban)"

    # UFW
    ufw allow 22/tcp >/dev/null 2>&1
    ufw allow 26656/tcp >/dev/null 2>&1
    ufw allow 26657/tcp >/dev/null 2>&1
    ufw --force enable >/dev/null 2>&1
    log "UFW enabled (ports 22, 26656, 26657)"

    echo ""
    log "Phase 1 COMPLETE."
    echo ""
    echo "  NEXT STEPS:"
    echo "  1. In a NEW terminal, verify ensoul login:"
    echo "     ssh ensoul@THIS_IP 'echo ok && sudo whoami'"
    echo ""
    echo "  2. If that works, run phase2:"
    echo "     ssh ensoul@THIS_IP 'sudo bash -s' < scripts/harden-ssh.sh phase2"
    echo ""
    echo "  DO NOT close this root session until step 1 succeeds."
    echo ""
}

phase2() {
    log "Phase 2: Disabling root login and password authentication"

    # Verify we are NOT root (should be ensoul with sudo)
    if [ "$(id -u)" = "0" ] && [ "$(logname 2>/dev/null || echo root)" = "root" ]; then
        log "WARNING: Running as root. Ensure ensoul user works before proceeding."
    fi

    # Disable root login
    sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
    # Disable password auth
    sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

    # Reload SSH config without restarting the service (prevents lockout)
    kill -HUP "$(pgrep -o sshd)" 2>/dev/null || true
    log "SSH config reloaded (SIGHUP, no restart)"

    echo ""
    log "Phase 2 COMPLETE."
    echo "  Root login: disabled"
    echo "  Password auth: disabled"
    echo "  Key-only auth: enabled"
    echo "  fail2ban: active"
    echo "  UFW: 22 + 26656 + 26657"
    echo ""
}

case "$PHASE" in
    phase1) phase1 ;;
    phase2) phase2 ;;
    *)
        echo "Ensoul SSH Hardening Script"
        echo ""
        echo "Usage:"
        echo "  Phase 1: ssh root@IP 'bash -s' < harden-ssh.sh phase1 \"ssh-ed25519 AAAA...\""
        echo "  Phase 2: ssh ensoul@IP 'sudo bash -s' < harden-ssh.sh phase2"
        echo ""
        echo "Phase 1: create user, add key, fail2ban, UFW (safe, keeps root)"
        echo "Phase 2: disable root and password auth (run after verifying ensoul works)"
        ;;
esac
