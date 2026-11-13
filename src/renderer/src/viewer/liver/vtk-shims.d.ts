// vtk.js ships no types for this filter.
declare module '@kitware/vtk.js/Filters/General/ImageMarchingCubes' {
  import type vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData'
  import type vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData'
  interface vtkImageMarchingCubes {
    setInputData(data: vtkImageData): void
    setContourValue(v: number): void
    getOutputData(): vtkPolyData
  }
  const vtkImageMarchingCubes: {
    newInstance(init?: { contourValue?: number; computeNormals?: boolean; mergePoints?: boolean }): vtkImageMarchingCubes
  }
  export default vtkImageMarchingCubes
}
