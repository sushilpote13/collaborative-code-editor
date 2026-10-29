import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    username: {
      type: String,
      required: true,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 20,
      match: /^[a-z][a-z0-9_]{2,19}$/,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    cognitoSub: {
      type: String,
      unique: true,
      sparse: true,
    },
    // The name Amazon Cognito signs this account in with. The user pool uses
    // the email address as its sign-in attribute, so that address is the name
    // of the account inside Cognito. It is kept in the case the person
    // registered with, because Cognito compares it exactly.
    cognitoUsername: {
      type: String,
      trim: true,
    },
    // Legacy local-credential hash kept only so accounts that predate Cognito
    // keep their stored value untouched. It is never written, selected, or
    // compared by the application, and it is not required for new accounts.
    passwordHash: {
      type: String,
      required: false,
      select: false,
    },
  },
  { timestamps: true },
);

const User = mongoose.model('User', userSchema);

export default User;
