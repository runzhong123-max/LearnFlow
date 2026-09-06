import base64
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('prepare_launch',Path(__file__).resolve().parents[1]/'prepare_launch.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class PrepareLaunchTests(unittest.TestCase):
    def test_private_configuration_never_rotates_existing_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'.env'
            module.prepare('learnflow.test',path)
            original=path.read_bytes()
            values=dict(line.split('=',1) for line in path.read_text().splitlines() if line and not line.startswith('#') and '=' in line)
            self.assertEqual(values['LEARNFLOW_HOST'],'learn.learnflow.test')
            self.assertEqual(len({values[key] for key in module.SECRET_KEYS}),len(module.SECRET_KEYS))
            self.assertEqual(len(base64.urlsafe_b64decode(values['AUTH_API_KEY_KEK'])),32)
            if os.name!='nt':self.assertEqual(path.stat().st_mode & 0o777,0o600)
            with self.assertRaises(FileExistsError):module.prepare('learnflow.test',path)
            self.assertEqual(path.read_bytes(),original)
    def test_untrusted_domain_is_not_written(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'.env'
            for domain in ['https://site.test','a.test/path','a.test\nBAD=true','*.site.test','localhost']:
                with self.assertRaises(ValueError):module.prepare(domain,path)
                self.assertFalse(path.exists())

if __name__=='__main__':unittest.main()
