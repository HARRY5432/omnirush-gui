#!/usr/bin/env bash
# Build the OmniRush VM's disk image (the macOS backend's Lima `vz` VM, src/box/backends/lima.js):
#   sudo box/vm/build-image.sh <version> [arm64|amd64] [out dir]
# Runs as root on a Debian 13 (trixie) machine of the target architecture (an arm64 or amd64
# runner, or the OmniRush VM itself), with: mmdebstrap e2fsprogs dosfstools mtools fdisk
# qemu-utils grub-efi-<arch>-bin. Optional: BOX_BIN=<dir with linux-<arch>/{boxrun,boxd}> bakes
# the helpers in (clients still copy their own); SNAPSHOT=<YYYYMMDDTHHMMSSZ> builds from
# snapshot.debian.org at that time (a rebuild then gives the same packages).
# Prints the pin line for src/box/required.json setup.darwin.vm.image.custom. Nothing is published here.
set -euo pipefail
VERSION=${1:?version, e.g. 2026.10.1}; ARCH=${2:-arm64}; OUT=$(mkdir -p "${3:-dist}" && cd "${3:-dist}" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
case "$ARCH" in
  arm64) KERNEL=linux-image-cloud-arm64; GRUB_TARGET=arm64-efi; EFI_NAME=BOOTAA64.EFI ;;
  amd64) KERNEL=linux-image-cloud-amd64; GRUB_TARGET=x86_64-efi; EFI_NAME=BOOTX64.EFI ;;
  *) echo "arch: arm64 or amd64"; exit 2 ;;
esac
for tool in mmdebstrap mke2fs mkfs.vfat mcopy sfdisk qemu-img grub-mkstandalone; do command -v "$tool" >/dev/null || { echo "missing $tool"; exit 1; }; done
[ -d "/usr/lib/grub/$GRUB_TARGET" ] || { echo "missing grub-efi-$ARCH-bin"; exit 1; }
MIRROR=http://deb.debian.org/debian; SECURITY=http://deb.debian.org/debian-security
if [ -n "${SNAPSHOT:-}" ]; then MIRROR="http://snapshot.debian.org/archive/debian/$SNAPSHOT"; SECURITY="http://snapshot.debian.org/archive/debian-security/$SNAPSHOT"; fi
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
ROOT=$WORK/root
# What Lima's boot needs on a Debian guest (cloud-init with NoCloud and netplan, sshd, sudo,
# rsync, growpart) and what the boxes need (overlay, unshare: util-linux; ca-certificates for
# boxrun's own image pulls). No compilers, no docs, no locales: the boxes bring their own userland.
PKGS="systemd-sysv,systemd-resolved,systemd-timesyncd,udev,dbus,libpam-systemd,kmod,initramfs-tools,$KERNEL"
PKGS="$PKGS,cloud-init,cloud-guest-utils,netplan.io,openssh-server,sudo,ca-certificates,iproute2,rsync,e2fsprogs,fdisk,util-linux,procps"
mmdebstrap --mode=root --variant=apt --arch="$ARCH" --include="$PKGS" \
  --dpkgopt='path-exclude=/usr/share/doc/*' --dpkgopt='path-include=/usr/share/doc/*/copyright' \
  --dpkgopt='path-exclude=/usr/share/man/*' --dpkgopt='path-exclude=/usr/share/info/*' \
  --dpkgopt='path-exclude=/usr/share/locale/*' --dpkgopt='path-include=/usr/share/locale/locale.alias' \
  --customize-hook="cp '$HERE/fstab' \"\$1/etc/fstab\"" \
  --customize-hook="cp '$HERE/cloud.cfg' \"\$1/etc/cloud/cloud.cfg.d/90-omnirush.cfg\"" \
  --customize-hook='echo omnirush-box > "$1/etc/hostname"' \
  --customize-hook='rm -f "$1"/etc/ssh/ssh_host_* && : > "$1/etc/machine-id" && rm -f "$1/var/lib/dbus/machine-id"' \
  --customize-hook='mkdir -p "$1/opt/omnirush" "$1/var/lib/omnirush/store" "$1/var/lib/omnirush/boxes" "$1/var/lib/omnirush/shadows"' \
  --customize-hook='rm -rf "$1"/var/lib/apt/lists/* "$1"/var/cache/apt/*.bin "$1"/var/log/*.log "$1"/var/cache/debconf/*-old' \
  trixie "$ROOT" "deb $MIRROR trixie main" "deb $MIRROR trixie-updates main" "deb $SECURITY trixie-security main"
if [ -n "${BOX_BIN:-}" ]; then
  install -m 0755 "$BOX_BIN/linux-$ARCH/boxrun" "$ROOT/opt/omnirush/boxrun"
  install -m 0755 "$BOX_BIN/linux-$ARCH/boxd" "$ROOT/opt/omnirush/boxd"
fi
printf '{"image":"omnirush-vm","version":"%s","arch":"%s","suite":"trixie","snapshot":"%s"}\n' "$VERSION" "$ARCH" "${SNAPSHOT:-}" > "$ROOT/etc/omnirush-vm.json"
KVER=$(ls "$ROOT/boot" | sed -n 's/^vmlinuz-//p' | sort -V | tail -1)
[ -n "$KVER" ] && [ -f "$ROOT/boot/initrd.img-$KVER" ] || { echo "no kernel/initrd in the root"; exit 1; }
# EFI: one standalone GRUB with its config inside (vz boots the removable path, /EFI/BOOT/<name>).
sed "s/@KVER@/$KVER/g" "$HERE/grub.cfg" > "$WORK/grub.cfg"
grub-mkstandalone -O "$GRUB_TARGET" --modules="part_gpt ext2 search search_label linux normal gzio" \
  --locales= --fonts= --themes= -o "$WORK/$EFI_NAME" "boot/grub/grub.cfg=$WORK/grub.cfg"
mkfs.vfat -n OMNIEFI -C "$WORK/esp.img" 32768 >/dev/null
mmd -i "$WORK/esp.img" ::/EFI ::/EFI/BOOT
mcopy -i "$WORK/esp.img" "$WORK/$EFI_NAME" "::/EFI/BOOT/$EFI_NAME"
# The root filesystem: its files plus room; cloud-init's growpart grows it to Lima's disk size at first boot.
USED=$(du -sm "$ROOT" | cut -f1); ROOT_MB=$(( (USED * 13 / 10) + 256 ))
mke2fs -q -t ext4 -L omnirush-root -E root_owner=0:0 -d "$ROOT" "$WORK/root.img" "${ROOT_MB}M"
ESP_START=2048; ESP_SECTORS=65536; ROOT_START=$((ESP_START + ESP_SECTORS)); ROOT_SECTORS=$((ROOT_MB * 2048))
truncate -s $(( (ROOT_START + ROOT_SECTORS) * 512 + 1024 * 1024 )) "$WORK/disk.raw"
sfdisk -q "$WORK/disk.raw" <<PART
label: gpt
start=$ESP_START, size=$ESP_SECTORS, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name="esp"
start=$ROOT_START, size=$ROOT_SECTORS, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="root"
PART
dd if="$WORK/esp.img" of="$WORK/disk.raw" bs=512 seek=$ESP_START conv=notrunc,sparse status=none
dd if="$WORK/root.img" of="$WORK/disk.raw" bs=512 seek=$ROOT_START conv=notrunc,sparse status=none
FILE="$OUT/omnirush-vm-$VERSION-$ARCH.qcow2"
qemu-img convert -q -f raw -O qcow2 -c "$WORK/disk.raw" "$FILE"
SHA=$(sha256sum "$FILE" | cut -d' ' -f1); BYTES=$(stat -c %s "$FILE")
echo "{\"$([ "$ARCH" = amd64 ] && echo x64 || echo arm64)\": {\"url\": \"<release asset url>\", \"sha256\": \"$SHA\", \"bytes\": $BYTES}, \"version\": \"$VERSION\", \"kernel\": \"$KVER\", \"root_mb\": $USED}"
echo "$FILE" >&2
