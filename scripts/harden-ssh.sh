#!/usr/bin/env bash
#
# harden-ssh.sh
#
# SSH Hardening GUIDE for Ensoul cloud validators.
# This script PRINTS instructions for JD to run manually.
# It NEVER SSHes into anything. It NEVER runs remote commands.
# It NEVER touches sshd_config, UFW, or the SSH daemon.
#
# Usage:
#   bash scripts/harden-ssh.sh <IP>
#   bash scripts/harden-ssh.sh all
#

set -euo pipefail

CLOUD_IPS=(
    "178.156.199.91"
    "5.78.199.4"
    "204.168.192.25"
    "178.104.95.163"
    "157.230.54.91"
    "152.42.175.202"
    "188.166.169.3"
)

print_guide() {
    local IP="$1"
    cat << GUIDE

================================================================
  SSH Hardening Guide for $IP
================================================================

PHASE 1: Create user and security tools (safe, keeps root)
Open a terminal and run these commands:

  ssh root@$IP

Then on the server:

  # Create ensoul user with sudo
  adduser --disabled-password --gecos "" ensoul
  usermod -aG sudo ensoul
  echo "ensoul ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ensoul

  # Copy SSH key
  mkdir -p /home/ensoul/.ssh
  cp ~/.ssh/authorized_keys /home/ensoul/.ssh/
  chown -R ensoul:ensoul /home/ensoul/.ssh
  chmod 700 /home/ensoul/.ssh
  chmod 600 /home/ensoul/.ssh/authorized_keys

  # Install fail2ban
  apt-get install -y fail2ban
  cat > /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
port = 22
maxretry = 3
bantime = 3600
EOF
  systemctl enable fail2ban
  systemctl restart fail2ban

  # Symlink chain data
  ln -sf /root/.cometbft-ensoul /home/ensoul/.cometbft-ensoul
  ln -sf /root/.ensoul /home/ensoul/.ensoul
  ln -sf /root/ensoul /home/ensoul/ensoul
  chmod 755 /root

NOW STOP. Do NOT close this root session.

PHASE 2: Verify ensoul login (in a NEW terminal)

  ssh ensoul@$IP
  sudo whoami    # Should print: root

If this works, proceed to Phase 3.
If this fails, DO NOT proceed. Fix the key first.

PHASE 3: Lock down root (back in the root session)

  sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

  # Reload SSH (NOT restart)
  systemctl reload ssh    # Ubuntu 22.04
  # or: systemctl reload sshd   # if 'ssh' doesn't work

PHASE 4: Verify lockout (in another terminal)

  ssh root@$IP    # Should say: Permission denied
  ssh ensoul@$IP  # Should work

================================================================

GUIDE
}

if [ "${1:-}" = "all" ]; then
    for ip in "${CLOUD_IPS[@]}"; do
        print_guide "$ip"
    done
elif [ -n "${1:-}" ]; then
    print_guide "$1"
else
    echo "Usage: bash scripts/harden-ssh.sh <IP>"
    echo "       bash scripts/harden-ssh.sh all"
    echo ""
    echo "Prints SSH hardening instructions for JD to run manually."
    echo "This script NEVER SSHes into anything or runs remote commands."
    echo ""
    echo "Known cloud validators:"
    for ip in "${CLOUD_IPS[@]}"; do
        echo "  $ip"
    done
fi
