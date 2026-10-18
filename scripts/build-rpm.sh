#!/usr/bin/env bash

set -euo pipefail

version="${VERSION:?VERSION is required.}"
runner_temp="${RUNNER_TEMP:?RUNNER_TEMP is required.}"
rpm_root="$runner_temp/rpmbuild"
source_root="$runner_temp/source"
package_root="$source_root/pm3-$version"

mkdir -p "$rpm_root"/{BUILD,RPMS,SOURCES,SPECS,SRPMS} "$package_root"

tar --exclude-vcs --exclude=./dist --exclude=./.github --exclude=./target -cf - . |
  tar -xf - -C "$package_root"
tar -czf "$rpm_root/SOURCES/pm3-$version.tar.gz" -C "$source_root" "pm3-$version"
install -m0755 dist/pm3 "$rpm_root/SOURCES/pm3-linux-x86_64"
install -m0644 packaging/pm3.service "$rpm_root/SOURCES/pm3.service"
sed "s/^Version:[[:space:]].*/Version:        $version/" pm3.spec > "$rpm_root/SPECS/pm3.spec"

rpmbuild --define "_topdir $rpm_root" --nodeps -bb "$rpm_root/SPECS/pm3.spec"

mkdir -p dist/release
find "$rpm_root/RPMS" -type f -name "pm3-$version-*" -exec cp {} dist/release/ \;
