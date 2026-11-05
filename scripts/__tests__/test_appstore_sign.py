"""Signing preflight must reject mismatched/development/expired profiles."""
import copy
import datetime as dt
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import base64

spec = importlib.util.spec_from_file_location('sign_appstore', Path(__file__).parents[1] / 'sign-appstore.py')
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 11, 5, tzinfo=dt.timezone.utc)
        self.cert = hashlib.sha1(b'test-certificate').hexdigest().upper()
        self.profile = {
            'UUID': 'test', 'ExpirationDate': dt.datetime(2027, 1, 1), 'Platform': ['OSX'],
            'TeamIdentifier': ['TEAM'], 'ApplicationIdentifierPrefix': ['PREFIX'],
            'DeveloperCertificates': [b'test-certificate'],
            'Entitlements': {'com.apple.application-identifier': 'PREFIX.com.example.store',
                             'com.apple.developer.team-identifier': 'TEAM'}}

    def validate(self, profile):
        return signing.validate_profile(profile, 'com.example.store', self.cert, self.now)

    def test_app_prefix_is_not_assumed_to_be_team(self):
        self.assertEqual(self.validate(self.profile)['applicationId'], 'PREFIX.com.example.store')

    def test_wrong_distribution_or_expired_profile_fails(self):
        for field, value in [('ExpirationDate', dt.datetime(2025, 1, 1)), ('Platform', ['iOS']),
                             ('ProvisionedDevices', []), ('ProvisionsAllDevices', True),
                             ('DeveloperCertificates', [b'wrong-certificate'])]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate({**self.profile, field: value})

    def test_entitlement_mismatches_fail(self):
        for field, value in [('com.apple.application-identifier', 'PREFIX.com.example.direct'),
                             ('com.apple.developer.team-identifier', 'OTHER'),
                             ('get-task-allow', True), ('com.apple.security.get-task-allow', True)]:
            profile = copy.deepcopy(self.profile)
            profile['Entitlements'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate(profile)

    def test_duplicate_identity_is_ok_but_wrong_kind_is_not(self):
        output = '1) ABC "Apple Distribution: Test (TEAM)"\n2) ABC "Apple Distribution: Test (TEAM)"'
        self.assertEqual(signing.identity_name(output, 'ABC', r'Apple Distribution: .+ \(TEAM\)'),
                         'Apple Distribution: Test (TEAM)')
        with self.assertRaises(ValueError):
            signing.identity_name(output, 'ABC', r'3rd Party Mac Developer Installer: .+')


    def test_package_status_requires_exact_installer_fingerprint(self):
        cert = b'test-installer-certificate'
        sha1 = hashlib.sha1(cert).hexdigest().upper()
        sha256 = hashlib.sha256(cert).hexdigest().upper()
        name = '3rd Party Mac Developer Installer: Test (TEAM)'
        pem = b'-----BEGIN CERTIFICATE-----\n' + base64.b64encode(cert) + b'\n-----END CERTIFICATE-----'
        for status, fingerprint, valid in [
            ('signed by a developer certificate issued by Apple (Development)', sha256, True),
            ('signed by a developer certificate issued by Apple (Development)', 'WRONG', False),
            ('invalid signature', sha256, False)]:
            output = ('Status: ' + status + '\n' + name + '\nSHA256 Fingerprint: ' + fingerprint).encode()
            with self.subTest(status=status, fingerprint=fingerprint), patch.object(signing, 'run', side_effect=[output, pem]):
                if valid:
                    self.assertIn(name, signing.verify_package_signature('test.pkg', name, sha1))
                else:
                    with self.assertRaises(ValueError):
                        signing.verify_package_signature('test.pkg', name, sha1)


if __name__ == '__main__':
    unittest.main()
