import pathlib
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
REQUIRED=(
 'README.md','requirements-dev.txt','fixture/PipeBWrite.pdf',
 'fixture/figure2-original-3x.png','fixture/figure3-original-3x.png',
 'fixture/page5-original-2x.png','fixture/fixture-verified.json',
 'scripts/inspect_pdf.py','docs/STAGE_A_IMPLEMENTATION_SPEC.md',
 'docs/STAGE_B_USER_CHECKLIST.md','docs/CODEX_START_PROMPT.md')
class PackageTests(unittest.TestCase):
 def test_all_files(self):
  for name in REQUIRED:
   with self.subTest(name=name): self.assertTrue((ROOT/name).is_file())
if __name__=='__main__': unittest.main()
