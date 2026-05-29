module.exports = {
    testEnvironment: 'node',
    transform: { '^.+\\.[jt]sx?$': 'babel-jest' },
    testMatch: ['**/tests/**/*.test.js'],
    collectCoverageFrom: ['src/**/*.{js,jsx}'],
    setupFiles: ['<rootDir>/tests/setup.js'],
};
