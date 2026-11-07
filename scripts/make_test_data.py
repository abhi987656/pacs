"""
Generates synthetic (fake, anonymous) DICOM studies for testing Personal PACS.

    pip install pydicom numpy pylibjpeg pylibjpeg-openjpeg pyjpegls
    python scripts/make_test_data.py <output-folder>

Creates:
  <out>/ct_current/   CT chest+abdomen (topogram, venous 5 mm, lung 2.5 mm, arterial in JPEG-LS,
                      venous copy in JPEG 2000 and RLE) for patient TEST001
  <out>/ct_prior/     older CT abdomen of the same patient (for comparison / previous reports)
  <out>/mr_cd/        MR brain of patient TEST002 laid out like a patient CD, with DICOMDIR and
                      extension-less file names
  <out>/junk/         a few non-DICOM files that the importer must skip
No real patient data is used.
"""
import os
import sys
from datetime import datetime

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.fileset import FileSet
from pydicom.uid import (
    CTImageStorage,
    ExplicitVRLittleEndian,
    JPEG2000Lossless,
    JPEGLSLossless,
    MRImageStorage,
    RLELossless,
    generate_uid,
)

OUT = sys.argv[1] if len(sys.argv) > 1 else "test-data"


def ellipse(shape, cy, cx, ry, rx):
    y, x = np.ogrid[: shape[0], : shape[1]]
    return ((y - cy) / ry) ** 2 + ((x - cx) / rx) ** 2 <= 1.0


def ct_slice(z_mm, size=256, lesion_scale=1.0, arterial=False):
    """Simple torso phantom in Hounsfield units. z_mm: 0 = top of liver, negative = lower."""
    img = np.full((size, size), -1000.0)
    c = size / 2
    body = ellipse(img.shape, c, c, size * 0.36, size * 0.46)
    img[body] = -100  # subcutaneous fat
    img[ellipse(img.shape, c, c, size * 0.33, size * 0.43)] = 35  # muscle / soft tissue
    if z_mm > 40:  # lung bases / chest
        img[ellipse(img.shape, c - 5, c - size * 0.2, size * 0.25, size * 0.16)] = -850
        img[ellipse(img.shape, c - 5, c + size * 0.2, size * 0.25, size * 0.16)] = -850
        img[ellipse(img.shape, c - 15, c + 10, size * 0.13, size * 0.12)] = 40  # heart
        # small nodule in right middle lobe
        if 60 < z_mm < 70:
            img[ellipse(img.shape, c - 20, c - size * 0.22, 4 * lesion_scale, 4 * lesion_scale)] = 30
    else:
        liver = ellipse(img.shape, c - 10, c - size * 0.18, size * 0.22, size * 0.2)
        img[liver] = 60 if not arterial else 70
        # hypodense liver lesions
        for (dy, dx, r) in [(-20, -60, 6), (10, -40, 4), (25, -75, 5)]:
            img[ellipse(img.shape, c + dy, c + dx, r * lesion_scale, r * lesion_scale) & liver] = 20
        img[ellipse(img.shape, c - 10, c + size * 0.25, size * 0.12, size * 0.08)] = 50  # spleen
        if z_mm < -20:
            img[ellipse(img.shape, c + 25, c - 45, 18, 12)] = 150 if not arterial else 200  # kidneys
            img[ellipse(img.shape, c + 25, c + 45, 18, 12)] = 150 if not arterial else 200
    img[ellipse(img.shape, c + 5, c + 8, 9, 9)] = 300 if arterial else 160  # aorta
    img[ellipse(img.shape, c + 5, c - 12, 9, 10)] = 140  # IVC
    img[ellipse(img.shape, c + 42, c, 15, 15)] = 700  # vertebral body
    img[ellipse(img.shape, c + 42, c, 7, 7)] = 30  # canal
    noise = np.random.default_rng(int(abs(z_mm) * 10) + 1).normal(0, 8, img.shape)
    return img + noise


def mr_slice(k, n, size=256, sagittal=False):
    img = np.zeros((size, size))
    c = size / 2
    t = (k - n / 2) / n
    scale = max(0.2, 1 - (2 * t) ** 2)
    if sagittal:
        img[ellipse(img.shape, c, c, size * 0.38 * scale + 10, size * 0.42)] = 300
        img[ellipse(img.shape, c - 5, c, size * 0.33 * scale + 5, size * 0.37)] = 650
        img[ellipse(img.shape, c + 60, c + 20, 25, 18)] = 500  # cerebellum
    else:
        img[ellipse(img.shape, c, c, size * 0.42 * scale + 10, size * 0.34 * scale + 10)] = 300  # scalp/skull
        img[ellipse(img.shape, c, c, size * 0.38 * scale + 5, size * 0.30 * scale + 5)] = 600  # brain
        if abs(t) < 0.2:
            img[ellipse(img.shape, c - 8, c - 10, 22, 6)] = 1400  # ventricles (bright on T2)
            img[ellipse(img.shape, c - 8, c + 10, 22, 6)] = 1400
    return img + np.random.default_rng(k + 7).normal(0, 15, img.shape)


def base_dataset(sop_class, study, series, number, transfer_syntax=ExplicitVRLittleEndian):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = transfer_syntax
    meta.ImplementationClassUID = generate_uid()
    ds = Dataset()
    ds.file_meta = meta
    ds.SpecificCharacterSet = "ISO_IR 100"
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    for k, v in study.items():
        setattr(ds, k, v)
    for k, v in series.items():
        setattr(ds, k, v)
    ds.InstanceNumber = number
    ds.ContentDate = study["StudyDate"]
    ds.ContentTime = study["StudyTime"]
    return ds


def set_pixels(ds, arr, signed, transfer_syntax):
    ds.Rows, ds.Columns = arr.shape
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16 if not signed else 16
    ds.HighBit = 15
    ds.PixelRepresentation = 1 if signed else 0
    data = arr.astype(np.int16 if signed else np.uint16)
    if transfer_syntax == ExplicitVRLittleEndian:
        ds.PixelData = data.tobytes()
    else:
        ds.BitsStored = 12 if not signed else 16
        ds.HighBit = ds.BitsStored - 1
        if not signed:
            data = np.clip(data, 0, 4095).astype(np.uint16)
        ds.compress(transfer_syntax, data)


def write_ct_series(folder, study, series_no, desc, n, thickness, z_top, size=256, transfer_syntax=ExplicitVRLittleEndian,
                    lesion_scale=1.0, arterial=False, kvp=120, ma=300):
    series = dict(
        Modality="CT",
        SeriesInstanceUID=generate_uid(),
        SeriesNumber=series_no,
        SeriesDescription=desc,
        BodyPartExamined="ABDOMEN",
        FrameOfReferenceUID=study["_for"],
        PatientPosition="HFS",
    )
    os.makedirs(folder, exist_ok=True)
    spacing = 384.0 / size
    for i in range(n):
        z = z_top - i * thickness
        ds = base_dataset(CTImageStorage, {k: v for k, v in study.items() if not k.startswith("_")}, series, i + 1, transfer_syntax)
        hu = ct_slice(z, size, lesion_scale, arterial)
        stored = np.clip(hu + 1024, 0, 4095)
        ds.RescaleIntercept = -1024
        ds.RescaleSlope = 1
        ds.RescaleType = "HU"
        ds.WindowCenter = 40
        ds.WindowWidth = 400
        ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
        ds.ImagePositionPatient = [-192.0, -192.0, float(z)]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing = [spacing, spacing]
        ds.SliceThickness = thickness
        ds.SpacingBetweenSlices = thickness
        ds.SliceLocation = float(z)
        ds.KVP = kvp
        ds.XRayTubeCurrent = ma
        ds.GantryDetectorTilt = 0
        ds.AcquisitionNumber = 1
        set_pixels(ds, stored, False, transfer_syntax)
        ds.save_as(os.path.join(folder, f"se{series_no:02d}_im{i + 1:04d}.dcm"), enforce_file_format=True)
    return series["SeriesInstanceUID"]


def write_topogram(folder, study):
    series = dict(Modality="CT", SeriesInstanceUID=generate_uid(), SeriesNumber=1, SeriesDescription="Topogram 0.6 T20f",
                  FrameOfReferenceUID=study["_for"])
    ds = base_dataset(CTImageStorage, {k: v for k, v in study.items() if not k.startswith("_")}, series, 1)
    img = np.full((512, 384), 0.0)
    img[ellipse(img.shape, 256, 192, 240, 150)] = 1100
    img[ellipse(img.shape, 150, 130, 90, 50)] = 400
    img[ellipse(img.shape, 150, 254, 90, 50)] = 400
    img[:, 182:202] = 1800
    ds.ImageType = ["ORIGINAL", "PRIMARY", "LOCALIZER"]
    ds.RescaleIntercept = -1024
    ds.RescaleSlope = 1
    ds.WindowCenter = 300
    ds.WindowWidth = 2000
    ds.PixelSpacing = [1.0, 1.0]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 0, -1]
    ds.ImagePositionPatient = [-192.0, 0.0, 150.0]
    set_pixels(ds, img, False, ExplicitVRLittleEndian)
    os.makedirs(folder, exist_ok=True)
    ds.save_as(os.path.join(folder, "se01_topogram.dcm"), enforce_file_format=True)


def study_info(pid, name, dob, sex, date, time, desc, acc, age):
    return dict(
        PatientID=pid,
        PatientName=name,
        PatientBirthDate=dob,
        PatientSex=sex,
        PatientAge=age,
        StudyInstanceUID=generate_uid(),
        StudyDate=date,
        StudyTime=time,
        StudyDescription=desc,
        AccessionNumber=acc,
        ReferringPhysicianName="TEST^REFERRER",
        InstitutionName="DEMO HOSPITAL",
        StudyID="1",
        _for=generate_uid(),
    )


def main():
    os.makedirs(OUT, exist_ok=True)
    # ---------------- patient 1: current CT + prior CT
    cur = study_info("TEST001", "TEST^ALPHA", "19700611", "M", "20261107", "141900", "CT CHEST/ABDOMEN", "ACC1001", "056Y")
    d = os.path.join(OUT, "ct_current")
    write_topogram(d, cur)
    write_ct_series(d, cur, 2, "ABD VENOUS 5mm", 40, 5.0, 100.0)
    write_ct_series(d, cur, 3, "LUNG 2.5mm", 40, 2.5, 120.0, kvp=100, ma=250)
    write_ct_series(d, cur, 4, "ARTERIAL 5mm (JPEG-LS)", 20, 5.0, 40.0, transfer_syntax=JPEGLSLossless, arterial=True)
    write_ct_series(d, cur, 5, "VENOUS 5mm (JPEG 2000)", 10, 5.0, 20.0, transfer_syntax=JPEG2000Lossless)
    write_ct_series(d, cur, 6, "VENOUS 5mm (RLE)", 10, 5.0, 20.0, transfer_syntax=RLELossless)

    prior = study_info("TEST001", "TEST^ALPHA", "19700611", "M", "20260123", "122000", "CT ABDOMEN", "ACC0901", "055Y")
    write_ct_series(os.path.join(OUT, "ct_prior"), prior, 2, "ABD VENOUS 5mm", 40, 5.0, 100.0, lesion_scale=0.8)

    # ---------------- patient 2: MR brain laid out like a CD (DICOMDIR, no extensions)
    mr = study_info("TEST002", "TEST^BRAVO", "19850203", "F", "20261105", "093000", "MRI BRAIN", "ACC2001", "041Y")
    fs = FileSet()
    tmp = []
    for (sno, desc, n, sag) in [(1, "AX T2 TSE", 20, False), (2, "SAG T1", 15, True)]:
        series = dict(Modality="MR", SeriesInstanceUID=generate_uid(), SeriesNumber=sno, SeriesDescription=desc,
                      FrameOfReferenceUID=mr["_for"], PatientPosition="HFS", BodyPartExamined="HEAD")
        for k in range(n):
            ds = base_dataset(MRImageStorage, {kk: v for kk, v in mr.items() if not kk.startswith("_")}, series, k + 1)
            ds.ImageType = ["ORIGINAL", "PRIMARY", "M", "ND"]
            ds.PixelSpacing = [0.9, 0.9]
            ds.SliceThickness = 5.0
            ds.RepetitionTime = 4000 if not sag else 500
            ds.EchoTime = 100 if not sag else 12
            ds.MagneticFieldStrength = 1.5
            if sag:
                ds.ImageOrientationPatient = [0, 1, 0, 0, 0, -1]
                ds.ImagePositionPatient = [float(-35 + k * 5), -115.0, 115.0]
            else:
                ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
                ds.ImagePositionPatient = [-115.0, -115.0, float(60 - k * 5)]
            ds.WindowCenter = 700
            ds.WindowWidth = 1400
            set_pixels(ds, np.clip(mr_slice(k, n, 256, sag), 0, 4000), False, ExplicitVRLittleEndian)
            p = os.path.join(OUT, "_mr_tmp", f"{sno}_{k}.dcm")
            os.makedirs(os.path.dirname(p), exist_ok=True)
            ds.save_as(p, enforce_file_format=True)
            tmp.append(p)
            fs.add(p)
    fs.write(os.path.join(OUT, "mr_cd"))
    for p in tmp:
        os.remove(p)
    os.rmdir(os.path.join(OUT, "_mr_tmp"))

    # ---------------- junk that must be skipped
    j = os.path.join(OUT, "junk")
    os.makedirs(j, exist_ok=True)
    open(os.path.join(j, "readme.txt"), "w").write("not dicom")
    open(os.path.join(j, "IMAGE0001"), "wb").write(os.urandom(2048))
    print("Test data written to", os.path.abspath(OUT), datetime.now().isoformat(timespec="seconds"))


if __name__ == "__main__":
    main()
