# box/vm: the OmniRush VM's disk image (macOS)

The macOS sandbox backend (`src/box/backends/lima.js`, backend id `lima`) runs one Linux VM per
user with a pinned Lima (`vz` driver). Each project's box runs inside it with `boxrun` as root,
the same way as in the WSL distro (`box/wsl`). This folder builds that VM's disk.

## What the image is

- Debian 13 (trixie), `mmdebstrap --variant=apt`, with only what Lima's boot and the boxes need:
  systemd (networkd, resolved, timesyncd), cloud-init (NoCloud: Lima's seed ISO) with netplan,
  openssh-server, sudo, rsync, cloud-guest-utils (growpart), util-linux, ca-certificates, and the
  `linux-image-cloud-<arch>` kernel. No docs, man pages or locales.
- A GPT disk: a 32 MiB EFI partition holding one standalone GRUB (its config inside,
  `grub.cfg`), then an ext4 root labelled `omnirush-root`. Lima grows the disk file to
  `setup.darwin.vm.disk_gib`, and cloud-init's growpart grows the root to it at first boot.
- `/opt/omnirush/{boxrun,boxd}` baked in when `BOX_BIN` is given. Clients still copy their own
  helpers to `/opt/omnirush/h/<stamp>/`, so the CLI and the desktop app never swap them under
  each other.
- `/etc/omnirush-vm.json` names the image version. The VM's contract file
  (`/opt/omnirush/vm.json`) is written by the client that made the VM.

First measurement (arm64, Apple M4, 2026-10-22, image 2026.10.22-dev2): a 142 MB qcow2 with
368 MB of files, 355 MB on the Mac after Lima converts it; the guest boots in 5 s and Lima
reports the new VM ready 6-8 s after `limactl start`. The official Debian genericcloud image is
336 MB to download, about 1.1 GB on the Mac, and ready in 40-44 s. (Without
`manage_etc_hosts`, every sudo in the guest waits on a host-name lookup and Lima's readiness
checks took 37 s.)

## Build

On a Debian 13 machine of the target architecture, as root (a native arm64 or amd64 runner, or
the OmniRush VM itself; there is no cross build):

    apt-get install mmdebstrap e2fsprogs dosfstools mtools fdisk qemu-utils grub-efi-arm64-bin
    BOX_BIN=box/bin SNAPSHOT=20261022T000000Z box/vm/build-image.sh 2026.10.1 arm64 dist

It prints the pin line for `src/box/required.json` → `setup.darwin.vm.image.custom.<arch>`
(`url` + `sha256`). With `SNAPSHOT`, the packages come from snapshot.debian.org at that time,
so a rebuild gives the same package set.

## Publish and pin

1. Upload `omnirush-vm-<version>-<arch>.qcow2` as a release asset (next to the WSL rootfs, in
   the box-images workflow).
2. Put `url`, `sha256` and `version` under `setup.darwin.vm.image.custom` in
   `src/box/required.json`, refresh `src/box/PARITY.sha256`, and port both to the desktop app.
3. Until then (`url`/`sha256` null), clients use `setup.darwin.vm.image.fallback`: the official
   Debian genericcloud image, pinned by Debian's published sha512.

A new image only applies to newly made VMs. A VM that exists keeps its disk: boxes, their
installs and the image store live on it. A different `contract` in `/opt/omnirush/vm.json` is
logged and handled by `omnirush sandbox reset --vm`, which only runs while no chat uses the VM.

## Test an image without publishing it

    OMNIRUSH_BOX_LIMA_IMAGE=/path/omnirush-vm-dev-arm64.qcow2 omnirush --sandbox

This uses the local file as it is, with no digest check.
