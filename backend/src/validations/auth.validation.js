import { body, param } from "express-validator";

export const registerValidator=()=>[
    body("name")
        .trim()
        .notEmpty().withMessage("name is required"),
    body("email")
        .trim()
        .notEmpty().withMessage("email is required")
        .isEmail().withMessage("please provide a valid email address"),
    body("password")
        .trim()
        .notEmpty().withMessage("password is required")
        .isLength({min:8}).withMessage("password must be at least 8 characters long"),
]

export const loginValidator=()=>[
    body("email")
        .trim()
        .notEmpty().withMessage("email is required")
        .isEmail().withMessage("please provide a valid email address"),
    body("password")
        .trim()
        .notEmpty().withMessage("password is required"),
]

export const googleAuthValidator=()=>[
    body("idToken")
        .trim()
        .notEmpty().withMessage("idToken is required"),
]

export const forgotPasswordValidator=()=>[
    body("email")
        .trim()
        .notEmpty().withMessage("email is required")
        .isEmail().withMessage("please provide a valid email address"),
]

export const resetPasswordValidator=()=>[
    param("token")
        .trim()
        .notEmpty().withMessage("reset token is required"),
    body("password")
        .trim()
        .notEmpty().withMessage("password is required")
        .isLength({min:8}).withMessage("password must be at least 8 characters long"),
]
