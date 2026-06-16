#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary_path="${1:-${repo_root}/dist/gof}"
output_dir="${2:-${repo_root}/frontend/release}"
package_name="gofer-flow-cli"
maintainer="Gofer Flow <maintainers@goferflow.local>"
description="Command line workflow automation tool for Gofer Flow"

if [[ ! -x "${binary_path}" ]]; then
  echo "CLI binary is missing or not executable: ${binary_path}" >&2
  exit 1
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "dpkg-deb is required to create the Debian package" >&2
  exit 1
fi

if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "rpmbuild is required to create the RPM package" >&2
  exit 1
fi

version="$(
  cd "${repo_root}"
  python - <<'PY'
import tomllib
from pathlib import Path

project = tomllib.loads(Path("pyproject.toml").read_text())
print(project["project"]["version"])
PY
)"

mkdir -p "${output_dir}"
work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

deb_root="${work_dir}/deb"
install -Dm755 "${binary_path}" "${deb_root}/usr/bin/gof"
install -Dm644 "${repo_root}/LICENSE" "${deb_root}/usr/share/doc/${package_name}/copyright"
mkdir -p "${deb_root}/DEBIAN"
cat >"${deb_root}/DEBIAN/control" <<EOF
Package: ${package_name}
Version: ${version}
Section: devel
Priority: optional
Architecture: amd64
Maintainer: ${maintainer}
Description: ${description}
 Gofer Flow is a local DAG workflow runner for deterministic automation,
 shell/script steps, and LLM-backed agent steps.
EOF

dpkg-deb --build --root-owner-group "${deb_root}" \
  "${output_dir}/${package_name}_${version}_amd64.deb"

rpm_top="${work_dir}/rpm"
mkdir -p "${rpm_top}/BUILD" "${rpm_top}/BUILDROOT" "${rpm_top}/RPMS" \
  "${rpm_top}/SOURCES" "${rpm_top}/SPECS" "${rpm_top}/SRPMS"
install -Dm755 "${binary_path}" "${rpm_top}/SOURCES/gof"
install -Dm644 "${repo_root}/LICENSE" "${rpm_top}/SOURCES/LICENSE"
cat >"${rpm_top}/SPECS/${package_name}.spec" <<EOF
Name:           ${package_name}
Version:        ${version}
Release:        1%{?dist}
Summary:        ${description}
License:        Apache-2.0
URL:            https://github.com/doonk/gofer-flow
BuildArch:      x86_64

%description
Gofer Flow is a local DAG workflow runner for deterministic automation,
shell/script steps, and LLM-backed agent steps.

%prep

%build

%install
mkdir -p %{buildroot}/usr/bin
install -m 0755 %{_sourcedir}/gof %{buildroot}/usr/bin/gof
mkdir -p %{buildroot}%{_licensedir}/%{name}
install -m 0644 %{_sourcedir}/LICENSE %{buildroot}%{_licensedir}/%{name}/LICENSE

%files
%license %{_licensedir}/%{name}/LICENSE
/usr/bin/gof
EOF

rpmbuild --define "_topdir ${rpm_top}" -bb "${rpm_top}/SPECS/${package_name}.spec"
cp "${rpm_top}/RPMS/x86_64/${package_name}-${version}-1"*.x86_64.rpm "${output_dir}/"

echo "Built CLI packages in ${output_dir}"
