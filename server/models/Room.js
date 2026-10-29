import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
      match: /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    state: {
      type: Buffer,
      required: false,
    },
  },
  { timestamps: true },
);

const Room = mongoose.model('Room', roomSchema);

export default Room;
