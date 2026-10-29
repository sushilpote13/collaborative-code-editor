export function createInitialCode(className = 'Main') {
  return `public class ${className} {
    public static void main(String[] args) {
        System.out.println("Hello, DevLoop!");
    }
}
`;
}

export const initialCode = createInitialCode();
