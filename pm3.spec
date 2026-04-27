Name:           pm3
Version:        1.1.1
Release:        2
Summary:        Container project manager

License:        GPL-3.0-only
URL:            https://github.com/ExposedCat/pm3
Source0:        %{name}-%{version}.tar.gz
Source1:        https://github.com/ExposedCat/pm3/releases/download/v%{version}/pm3-linux-x86_64
Source2:        https://github.com/ExposedCat/pm3/releases/download/v%{version}/pm3.service

BuildRequires:  systemd-rpm-macros
Requires:       podman
Requires:       podman-compose
%{?systemd_requires}
ExclusiveArch:  x86_64

%global debug_package %{nil}
%global __strip /bin/true
%{!?_unitdir:%global _unitdir %{_prefix}/lib/systemd/system}

%description
pm3 is a Deno-based CLI for managing container compose projects.

%prep
%autosetup -n %{name}-%{version}

%build
# The release binary is built by CI with Deno before the RPM build starts.

%check
# Tests run in CI before the release binary is published.

%install
install -Dm0755 %{SOURCE1} %{buildroot}%{_bindir}/pm3
install -Dm0644 %{SOURCE2} %{buildroot}%{_unitdir}/pm3.service

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
* Mon Apr 27 2026 Artem Prokop <artem13.prokop@gmail.com> 1.1.1-2
- feat: copr build badge (artem13.prokop@gmail.com)

* Mon Apr 27 2026 pm3 maintainers <maintainers@localhost> - 1.0.0-1
- Add initial RPM packaging and systemd unit
