Name:           pm3
Version:        1.0.0
Release:        1%{?dist}
Summary:        Container project manager

License:        GPL-3.0-only
URL:            https://github.com/ExposedCat/pm3
Source0:        %{name}-%{version}.tar.gz

BuildRequires:  deno
BuildRequires:  systemd-rpm-macros
Requires:       podman
Requires:       podman-compose
%{?systemd_requires}

%global debug_package %{nil}
%{!?_unitdir:%global _unitdir %{_prefix}/lib/systemd/system}

%description
pm3 is a Deno-based CLI for managing container compose projects.

%prep
%autosetup -n %{name}-%{version}

%build
mkdir -p dist
deno task build

%check
deno task test

%install
install -Dm0755 dist/pm3 %{buildroot}%{_bindir}/pm3
install -Dm0644 packaging/pm3.service %{buildroot}%{_unitdir}/pm3.service

%post
%systemd_post pm3.service

%preun
%systemd_preun pm3.service

%postun
%systemd_postun_with_restart pm3.service

%files
%license LICENSE.md
%doc README.md TODO.md
%{_bindir}/pm3
%{_unitdir}/pm3.service

%changelog
* Mon Apr 27 2026 pm3 maintainers <maintainers@localhost> - 1.0.0-1
- Add initial RPM packaging and systemd unit
