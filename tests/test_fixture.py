"""Validate supplied PDF structure; this Python oracle is not plugin runtime."""
import json
import pathlib
import unittest
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from inspect_pdf import scan

class PipeBWriteFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.expected=json.loads((ROOT/'fixture'/'fixture-verified.json').read_text(encoding='utf8'))
        cls.actual=scan(ROOT/'fixture'/'PipeBWrite.pdf',page_index=4)

    def test_identity_and_page_size(self):
        self.assertEqual(self.actual['sha256'],self.expected['sha256'])
        self.assertEqual(self.actual['page_size'],[612.,792.])
        self.assertFalse(self.actual['has_struct_tree'])
        self.assertEqual(self.actual['image_xobjects_count'],0)

    def test_two_form_xobjects(self):
        objs=self.actual['xobjects']
        self.assertEqual(len(objs),2)
        for item,expected in zip(objs,self.expected['xobjects']):
            self.assertEqual(item['name'],expected['name'])
            self.assertEqual(item['subtype'],'/Form')
            self.assertEqual(item['xref'],expected['xref'])
            for actual_num,expected_num in zip(item['bbox_page_top_left'],expected['bbox_page_top_left']):
                self.assertAlmostEqual(actual_num,expected_num,delta=.15)

    def test_caption_positions(self):
        for name in ('Figure 2:','Figure 3:'):
            self.assertTrue(self.actual['captions_top_left'][name])
        for ob,name in zip(self.actual['xobjects'],('Figure 2:','Figure 3:')):
            rect=ob['bbox_page_top_left']
            caption=self.actual['captions_top_left'][name][0]
            self.assertLess(abs(rect[0]-caption[0]),10)
            self.assertLess(caption[1]-rect[3],20)
            self.assertGreater(caption[1],rect[3])

if __name__=='__main__':unittest.main()
