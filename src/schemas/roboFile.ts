import mongoose from 'mongoose'

const RoboFileSchema = new mongoose.Schema({
  name: { type: String, name: 'File name', description: 'Name of the saved file', required: true, marked: true },
  path: { type: String, name: 'File path', description: 'Path of the saved file', required: true },
  size: { type: Number, name: 'File size', description: 'Sized of the saved file', required: true },
  type: { type: String, name: 'File type', description: 'MIME type of the saved file' },
  extension: { type: String, name: 'File extension', description: 'Extension of the saved file', required: true },
  isImage: { type: Boolean, name: 'Is image?', description: 'Indicates whether the saved file is an image or not', default: false },
  thumbnailPath: { type: String, name: 'Thumbnail path', description: 'Path of the saved thumbnail', default: null },
  uploadDate: { type: Date, name: 'Upload date', description: 'The date when the file was uploaded', default: () => new Date() },

  test: {type: [String], name: 'fwefwef'}
}, { selectPopulatedPaths: false })

export default mongoose.model('RoboFile', RoboFileSchema)
