#!/usr/bin/env python3
"""Build and verify a local Mac App Store candidate. Never uploads or exports keys."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import ssl
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_profile(profile, bundle_id, app_sha1, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    expiry = profile['ExpirationDate'].replace(tzinfo=dt.timezone.utc)
    require(expiry > now, 'Provisioning profile has expired')
    require(profile.get('Platform') == ['OSX'], 'Expected macOS provisioning profile')
    require('ProvisionedDevices' not in profile and not profile.get('ProvisionsAllDevices'),
            'Expected App Store profile, not a device/development profile')
    team = profile.get('TeamIdentifier', [])
    prefix = profile.get('ApplicationIdentifierPrefix', [])
    require(len(team) == len(prefix) == 1, 'Expected one team and App ID prefix')
    ent = profile.get('Entitlements', {})
    application_id = prefix[0] + '.' + bundle_id
    require(ent.get('com.apple.application-identifier') == application_id, 'Profile Bundle ID mismatch')
    require(ent.get('com.apple.developer.team-identifier') == team[0], 'Profile team mismatch')
    require(not ent.get('get-task-allow') and not ent.get('com.apple.security.get-task-allow'),
            'Debug entitlement is forbidden')
    certs = [hashlib.sha1(c).hexdigest().upper() for c in profile.get('DeveloperCertificates', [])]
    require(certs == [app_sha1], 'Profile must contain exactly the selected application certificate')
    return {'team': team[0], 'applicationId': application_id, 'uuid': profile['UUID'],
            'expiresAt': expiry.isoformat(), 'certificateSHA1': app_sha1}


def run(argv, *, capture=False, env=None):
    result = subprocess.run([str(a) for a in argv], cwd=ROOT, check=True,
                            stdout=subprocess.PIPE if capture else None, env=env)
    return result.stdout if capture else None


def identity_name(output, fingerprint, pattern):
    matches = re.findall(r'\b' + re.escape(fingerprint) + r' "([^"\n]+)"', output)
    require(matches and all(re.fullmatch(pattern, name) for name in matches),
            'Missing or wrong certificate identity: ' + fingerprint)
    return matches[0]


def verify_package_signature(pkg, installer_name, installer_sha1):
    pkg_check = run(['pkgutil', '--check-signature', pkg], capture=True).decode()
    require(installer_name in pkg_check and any(status in pkg_check for status in [
        'Status: signed by a certificate trusted by',
        'Status: signed by a developer certificate issued by Apple (Development)']),
            'Package signature is not trusted or installer identity differs')
    compact = re.sub(r'\s+', '', pkg_check).upper()
    # Recent macOS prints SHA-256 rather than SHA-1 in pkgutil output. Resolve
    # the exact keychain certificate selected by SHA-1, then compare SHA-256.
    pem = run(['security', 'find-certificate', '-a', '-c', installer_name, '-p'], capture=True).decode()
    certificates = [ssl.PEM_cert_to_DER_cert(c) for c in re.findall(
        r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', pem, re.S)]
    matching = [c for c in certificates if hashlib.sha1(c).hexdigest().upper() == installer_sha1]
    require(matching, 'Installer certificate not found for fingerprint verification')
    installer_sha256 = hashlib.sha256(matching[0]).hexdigest().upper()
    require(installer_sha256 in compact or installer_sha1 in compact,
            'Package installer certificate fingerprint mismatch')
    return pkg_check


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--app-identity', required=True, help='Application certificate SHA-1')
    parser.add_argument('--installer-identity', required=True, help='Installer certificate SHA-1')
    parser.add_argument('--build-number', required=True)
    args = parser.parse_args()
    require(os.uname().sysname == 'Darwin', 'macOS required')
    require(re.fullmatch(r'[1-9]\d{0,3}', args.build_number), 'Build number must be 1..9999')
    app_sha1, installer_sha1 = args.app_identity.upper(), args.installer_identity.upper()
    require(all(re.fullmatch(r'[A-F0-9]{40}', s) for s in [app_sha1, installer_sha1]),
            'Use complete certificate SHA-1 fingerprints')
    config = json.loads((ROOT / 'src-tauri/tauri.appstore.conf.json').read_text())
    require(config['identifier'] == 'com.simple-ai-writer.app.appstore', 'Unexpected store Bundle ID')
    require(config['build']['features'] == ['app-store'], 'Store feature must be enabled')
    profile_path = args.profile.resolve(strict=True)
    profile_bytes = profile_path.read_bytes()
    profile = plistlib.loads(run(['security', 'cms', '-D', '-i', profile_path], capture=True))
    facts = validate_profile(profile, config['identifier'], app_sha1)
    identities = run(['security', 'find-identity', '-v'], capture=True).decode()
    team_pattern = re.escape(facts['team'])
    app_name = identity_name(identities, app_sha1,
                            r'(?:Apple Distribution|3rd Party Mac Developer Application): .+ \(' + team_pattern + r'\)')
    installer_name = identity_name(identities, installer_sha1,
                                  r'3rd Party Mac Developer Installer: .+ \(' + team_pattern + r'\)')
    reports = ROOT / 'store-reports'
    reports.mkdir(exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='signed-' + args.build_number + '-', dir=reports))
    # Freeze public signing inputs for this run; no key material is copied.
    embedded = out / 'embedded.provisionprofile'
    embedded.write_bytes(profile_bytes)
    entitlements = plistlib.loads((ROOT / 'src-tauri/Entitlements.appstore.plist').read_bytes())
    entitlements.update({'com.apple.application-identifier': facts['applicationId'],
                         'com.apple.developer.team-identifier': facts['team']})
    ent_path = out / 'Entitlements.plist'
    ent_path.write_bytes(plistlib.dumps(entitlements))
    config['bundle']['macOS'].update({'bundleVersion': args.build_number,
        'signingIdentity': app_sha1, 'entitlements': str(ent_path),
        'files': {'embedded.provisionprofile': str(embedded)}})
    config_path = out / 'tauri.signed.json'
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    env = dict(os.environ)
    # Do not inherit alternate config/signing or notarization credentials. Store
    # submission uses this profile and installer signature, not Developer ID.
    for key in list(env):
        if key == 'TAURI_CONFIG' or key.startswith('APPLE_'):
            del env[key]
    target = ROOT / 'src-tauri/target/app-store-signed'
    env.update(MACOSX_DEPLOYMENT_TARGET='14.0', CARGO_TARGET_DIR=str(target))
    report = {'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
              'profile': facts, 'applicationIdentity': app_name, 'installerIdentity': installer_name,
              'installerSHA1': installer_sha1, 'buildNumber': args.build_number,
              'submissionReady': False, 'localSigningChecksPassed': False}
    report_path = out / 'signing-report.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print('Candidate directory:', out, flush=True)
    run(['pnpm', 'tauri', 'build', '--config', config_path, '--target', 'aarch64-apple-darwin'], env=env)
    built_app = target / 'aarch64-apple-darwin/release/bundle/macos' / (config['productName'] + '.app')
    app = out / built_app.name
    run(['ditto', built_app, app])
    require((app / 'Contents/embedded.provisionprofile').read_bytes() == profile_bytes,
            'Embedded provisioning profile differs from validated input')
    run(['codesign', '--verify', '--deep', '--strict', app])
    signed_ent = plistlib.loads(run(['codesign', '-d', '--entitlements', ':-', app], capture=True))
    require(signed_ent == entitlements, 'Signed entitlements differ from expected permissions')
    cert_prefix = str(out / 'app-certificate-')
    run(['codesign', '-d', '--extract-certificates=' + cert_prefix, app])
    leaf = Path(cert_prefix + '0')
    require(hashlib.sha1(leaf.read_bytes()).hexdigest().upper() == app_sha1,
            'Application was signed by an unexpected certificate')
    run(['node', 'scripts/audit-appstore.mjs', '--app', app, '--build-number', args.build_number,
         '--output', out / 'bundle-audit.json'])
    pkg = out / ('Simple-AI-Writer-Store-' + args.build_number + '.pkg')
    run(['xcrun', 'productbuild', '--sign', installer_sha1, '--component', app, '/Applications', pkg])
    pkg_check = verify_package_signature(pkg, installer_name, installer_sha1)
    (out / 'pkg-signature.txt').write_text(pkg_check)
    report.update(localSigningChecksPassed=True, app=str(app), package=str(pkg),
                  packageSHA256=hashlib.sha256(pkg.read_bytes()).hexdigest(),
                  pending=['App Store Connect validation/upload', 'Deferred native acceptance',
                           'Public privacy policy, metadata, license notices and encryption review'])
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print('Signed candidate verified:', pkg, flush=True)
    print('Not uploaded; submission readiness remains pending.', flush=True)


if __name__ == '__main__':
    main()
