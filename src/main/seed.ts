import type { Db } from './db'

// Starter templates. They are ordinary editable templates: change or delete them in
// Templates > Manage. Placeholders like {{prior_date}} are filled in when inserted.

const h = (title: string) => `<p><strong><u>${title}</u></strong></p>`
const imp = (text: string) => `<p><strong>IMPRESSION:</strong></p><p>${text}</p>`
const li = (items: string[]) => `<ul>${items.map((i) => `<li><p>${i}</p></li>`).join('')}</ul>`

const TEMPLATES: { name: string; modality: string; html: string }[] = [
  {
    name: 'NCCT Head',
    modality: 'CT',
    html:
      `<p><strong>TECHNIQUE:</strong> Non-contrast axial CT sections of the brain were obtained from the skull base to the vertex.</p>` +
      h('FINDINGS') +
      li([
        'Brain parenchyma shows normal attenuation. Grey-white matter differentiation is maintained.',
        'No evidence of intracranial haemorrhage, acute infarct or space-occupying lesion.',
        'Ventricular system and basal cisterns are normal in size and configuration. No midline shift.',
        'Cerebral sulci and Sylvian fissures are normal for age.',
        'Posterior fossa structures (cerebellum and brainstem) are normal.',
        'No extra-axial collection is seen.',
        'Calvarium and skull base are intact. Visualised paranasal sinuses and mastoid air cells are clear.'
      ]) +
      imp('No significant intracranial abnormality detected.')
  },
  {
    name: 'CECT Chest',
    modality: 'CT',
    html:
      `<p><strong>TECHNIQUE:</strong> Contrast-enhanced axial CT sections of the thorax were obtained from the thoracic inlet to the upper abdomen. Multiplanar reformations were reviewed.</p>` +
      h('FINDINGS') +
      li([
        'Both lungs are clear. No focal consolidation, nodule or mass is seen.',
        'Trachea and main bronchi are patent.',
        'No pleural effusion or pneumothorax.',
        'No mediastinal or hilar lymphadenopathy. Heart size is normal. No pericardial effusion.',
        'Thoracic aorta and main pulmonary artery are normal in calibre.',
        'Visualised upper abdomen is unremarkable.',
        'No lytic or sclerotic bony lesion is seen. Chest wall is unremarkable.'
      ]) +
      imp('No significant abnormality detected in the thorax.')
  },
  {
    name: 'HRCT Chest',
    modality: 'CT',
    html:
      `<p><strong>TECHNIQUE:</strong> Thin-section non-contrast CT of the chest reconstructed with a high-resolution algorithm.</p>` +
      h('FINDINGS') +
      li([
        'Lung parenchyma shows normal attenuation. No ground-glass opacity, consolidation, reticulation or interlobular septal thickening.',
        'No traction bronchiectasis or honeycombing.',
        'No bronchiectasis or bronchial wall thickening. No mosaic attenuation.',
        'No pulmonary nodule is seen.',
        'No pleural effusion or pleural thickening.',
        'Mediastinum is unremarkable. No significant lymphadenopathy.'
      ]) +
      imp('Normal HRCT chest.')
  },
  {
    name: 'CECT Abdomen & Pelvis',
    modality: 'CT',
    html:
      `<p><strong>TECHNIQUE:</strong> Contrast-enhanced CT of the abdomen and pelvis was performed in the portal venous phase. Multiplanar reformations were reviewed.</p>` +
      h('FINDINGS') +
      li([
        'Liver is normal in size and attenuation. No focal lesion. No IHBRD. Hepatic veins and portal vein are normal.',
        'Gallbladder is well distended. No calculus or wall thickening. CBD is normal in calibre.',
        'Pancreas is normal in size and enhancement. No focal lesion. MPD is not dilated.',
        'Spleen is normal in size and attenuation.',
        'Both adrenal glands are normal.',
        'Both kidneys are normal in size, position and enhancement. No calculus or hydronephrosis.',
        'Bowel loops are normal in calibre. No wall thickening.',
        'No significant lymphadenopathy. No ascites or collection.',
        'Abdominal aorta and IVC are normal in calibre.',
        'Urinary bladder is distended and normal.',
        'Prostate and bilateral seminal vesicles are unremarkable / Uterus and bilateral adnexae are unremarkable.',
        'Visualised lung bases are clear. No lytic or sclerotic bony lesion.'
      ]) +
      imp('No significant abnormality detected.')
  },
  {
    name: 'NCCT KUB',
    modality: 'CT',
    html:
      `<p><strong>TECHNIQUE:</strong> Non-contrast CT of the kidneys, ureters and bladder.</p>` +
      h('FINDINGS') +
      li([
        'Both kidneys are normal in size and position. No renal calculus. No hydronephrosis. Perinephric fat is clear.',
        'Both ureters are not dilated. No ureteric calculus is seen.',
        'Urinary bladder is well distended. No calculus. Wall is normal.',
        'Prostate / uterus is unremarkable.',
        'Visualised liver, spleen and bowel loops are unremarkable on this non-contrast study.',
        'No free fluid.'
      ]) +
      imp('No urolithiasis or hydronephrosis.')
  },
  {
    name: 'Comparison (follow-up)',
    modality: 'CT',
    html:
      `<p>Compared with previous scan dated {{prior_date}}.</p>` +
      h('CHEST') +
      li(['']) +
      h('ABDOMEN') +
      li(['']) +
      `<p>Rest of the findings are comparable to previous scan.</p>` +
      imp('')
  },
  {
    name: 'MRI Brain',
    modality: 'MR',
    html:
      `<p><strong>TECHNIQUE:</strong> Multiplanar multisequence MRI of the brain (T1W, T2W, FLAIR, DWI/ADC and SWI).</p>` +
      h('FINDINGS') +
      li([
        'Grey and white matter show normal signal intensity. No diffusion restriction to suggest acute infarct.',
        'No blooming on SWI to suggest haemorrhage.',
        'No space-occupying lesion, mass effect or midline shift.',
        'Ventricles, cisterns and cortical sulci are normal for age.',
        'Corpus callosum, basal ganglia, thalami, brainstem and cerebellum are normal.',
        'Sella and pituitary gland appear normal on the available sequences.',
        'Normal flow voids are seen in the major intracranial arteries and dural venous sinuses.',
        'Visualised orbits, paranasal sinuses and mastoids are unremarkable.'
      ]) +
      imp('No significant intracranial abnormality detected.')
  },
  {
    name: 'MRI LS Spine',
    modality: 'MR',
    html:
      `<p><strong>TECHNIQUE:</strong> Sagittal T1W, T2W and STIR and axial T2W images of the lumbosacral spine.</p>` +
      h('FINDINGS') +
      li([
        'Lumbar lordosis is maintained. Vertebral bodies are normal in height, alignment and marrow signal. No listhesis.',
        'Intervertebral discs show normal height and hydration at all levels. No disc bulge or protrusion.',
        'Spinal canal and neural foramina are adequate at all levels. No nerve root compression.',
        'Conus medullaris terminates at L1 level and shows normal signal. Cauda equina nerve roots are normal.',
        'Facet joints and ligamentum flavum are normal.',
        'Paravertebral soft tissues are normal.'
      ]) +
      imp('No significant abnormality detected in the lumbosacral spine.')
  },
  {
    name: 'MRI Knee',
    modality: 'MR',
    html:
      `<p><strong>TECHNIQUE:</strong> Multiplanar PD fat-saturated, T1W and T2W images of the knee.</p>` +
      h('FINDINGS') +
      li([
        'Medial and lateral menisci are normal in morphology and signal. No tear.',
        'Anterior and posterior cruciate ligaments are intact.',
        'Medial and lateral collateral ligament complexes are intact.',
        'Quadriceps and patellar tendons are intact.',
        'Articular cartilage is preserved. No subchondral marrow oedema.',
        'No bone bruise, fracture or osteochondral lesion.',
        "No significant joint effusion. No Baker's cyst."
      ]) +
      imp('No significant internal derangement of the knee.')
  },
  {
    name: 'USG Whole Abdomen',
    modality: 'US',
    html:
      h('FINDINGS') +
      li([
        'Liver is normal in size and echotexture. No focal lesion. No IHBRD.',
        'Gallbladder is well distended. No calculus. Wall is normal. CBD is normal.',
        'Pancreas and spleen are normal.',
        'Both kidneys are normal in size and echotexture with maintained corticomedullary differentiation. No calculus or hydronephrosis.',
        'Urinary bladder is well distended with normal wall.',
        'Prostate / uterus and adnexae are normal.',
        'No free fluid in the abdomen.'
      ]) +
      imp('No significant abnormality detected.')
  },
  {
    name: 'X-Ray Chest PA',
    modality: 'CR',
    html:
      li([
        'Trachea is central.',
        'Both lung fields are clear.',
        'Both costophrenic angles are clear.',
        'Cardiac size is within normal limits.',
        'Both hila are normal.',
        'Domes of diaphragm are normal in position and contour.',
        'Visualised bony thorax is intact.'
      ]) + imp('No significant abnormality detected.')
  }
]

const MACROS: { code: string; text: string }[] = [
  { code: 'nad', text: 'No abnormality detected.' },
  { code: 'nfl', text: 'No focal lesion is seen.' },
  { code: 'cmp', text: 'Rest of the findings are comparable to previous scan.' },
  { code: 'ubl', text: 'Urinary bladder is distended and normal.' },
  { code: 'pro', text: 'Prostate and bilateral seminal vesicles are unremarkable.' },
  { code: 'ut', text: 'Uterus and bilateral adnexae are unremarkable.' },
  { code: 'dg', text: 'Mild degenerative changes are seen in the visualized spine.' },
  { code: 'asc', text: 'No ascites is seen.' },
  { code: 'lad', text: 'No significant lymphadenopathy is seen.' },
  { code: 'ihbrd', text: 'No IHBRD is seen.' },
  { code: 'lb', text: 'Visualised lung bases are clear.' },
  { code: 'cc', text: 'Suggested clinical correlation.' },
  { code: 'fu', text: 'Suggested follow-up imaging.' }
]

export function seedIfEmpty(db: Db): void {
  if (db.templateCount() === 0) {
    for (const t of TEMPLATES) db.saveTemplate({ ...t, mine: false })
  }
  if (db.macroCount() === 0) {
    for (const m of MACROS) db.saveMacro(m)
  }
}
